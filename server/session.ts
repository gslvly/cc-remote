import { getSessionInfo, type EffortLevel, type PermissionMode, type RewindFilesResult } from '@anthropic-ai/claude-agent-sdk'
import type {
  EventEnvelope,
  HistoryPage,
  ImageAttachment,
  LiveUpdate,
  PermissionDecisionBody,
  RewindRestore,
  RewindResult,
  SessionEvent,
  SessionInfo,
  SessionState,
  SetModelBody,
  StreamHello,
} from '../shared/protocol'
import { EventBuffer, type EventId } from './buffer'
import { resolveModel } from './catalog'
import { rewindFiles } from './child'
import { Run, type RunHost } from './run'
import { bashInput, bashOutput, runShell } from './shell'
import type { Holder } from './terminal'
import { fromUserText, keptBefore, readTranscript, titleOf, type TranscriptEntry } from './transcript'
import { modelFacts, UsageTracker } from './usage'

export type { EventId }

export type StreamMsg =
  | { event: 'hello'; data: StreamHello }
  | { event: 'ev'; data: EventEnvelope }
  | { event: 'live'; data: LiveUpdate }
  | { event: 'state'; data: SessionInfo }
  | { event: 'deleted'; data: null }
type Listener = (msg: StreamMsg) => void

/** 登记表里终端进程的 status → 会话状态。waiting 是终端在等人操作（审批、回答），手机上只能看 */
const TERMINAL_STATE: Record<string, SessionState> = { busy: 'running', shell: 'running', waiting: 'requires_action', idle: 'idle' }

/** 终端还占着这个会话 */
export class ConflictError extends Error {}

/**
 * 一个会话：手机上开的（托管）、从目录页打开的历史会话、终端里正在跑的，都是它。
 * - 事件缓冲跟着会话走，子进程（Run）可以随时回收：回收后状态仍是 idle，下次发消息时 resume，epoch 和 seq 都接着用，手机端察觉不到。
 * - 没有子进程时，缓冲与 transcript 对齐（sync）：历史会话打开时整段载入，终端会话在手机看着时跟着 transcript 追加。
 *   SDK 流里消息的 uuid 与 transcript 一致，发给 SDK 的用户消息也指定了 uuid，所以从缓冲里最后一条接着补就不会重复
 */
export class Session implements RunHost {
  /** 加进本服务端的时间（标签按它排） */
  readonly createdAt = Date.now()
  lastActivity: number
  title: string
  model?: string
  permissionMode?: PermissionMode
  /** 手机上切的模型（别名）、effort，只对本会话；起子进程时带上 */
  private modelChoice?: string
  private effortChoice?: EffortLevel
  /** 手机上开的、在手机上发过消息的：进标签条（前端标签条只放这些，终端会话在首页、目录页） */
  owned = false
  terminal?: 'running'
  /** 持有它的终端进程报的 status */
  private terminalStatus?: string
  /** 最后一次有人打开或离开，没进标签条的会话按它从内存里清掉 */
  touchedAt = Date.now()

  private buffer = new EventBuffer()
  /** 主链最近一次 API 调用的用量（状态栏） */
  private usage = new UsageTracker()
  /** 上次对齐时 transcript 的大小和修改时间，没变就不用再读 */
  private stamp?: string
  private syncing?: Promise<void>
  private listeners = new Set<Listener>()
  private run?: Run
  /** 起过子进程了：再起就 resume，不再用 sessionId 新建 */
  private spawned = false
  /**
   * 回退过对话、还没发新消息：对话截在这条（含）。transcript 要等下一条消息写进去才从这里分叉，
   * 在那之前起子进程都带上它（resumeSessionAt），也不追 transcript（后面还是回退掉的那些）
   */
  private resumeAt?: string
  /** 正在跑的 ! 命令，中断时停掉它。跑完才把输入输出交给子进程，在那之前缓冲里有、transcript 里还没有，不对齐 */
  private shell?: AbortController

  /** fresh：新会话，第一次起子进程时用这个 id 新建；否则是已有的会话，起子进程就 resume */
  constructor(
    readonly id: string,
    readonly cwd: string,
    title: string,
    private onChange: () => void,
    opts: { fresh: boolean; lastActivity?: number },
  ) {
    this.title = title
    this.spawned = !opts.fresh
    this.lastActivity = opts.lastActivity ?? Date.now()
  }

  get epoch() {
    return this.buffer.epoch
  }

  get lastSeq() {
    return this.buffer.lastSeq
  }

  get live() {
    return this.run !== undefined
  }

  /** 进标签条（概览流）的：托管的，和终端里正在跑的 */
  get listed() {
    return this.owned || this.terminal === 'running'
  }

  get watched() {
    return this.listeners.size > 0
  }

  get effortChosen() {
    return this.effortChoice !== undefined
  }

  get state(): SessionState {
    if (this.terminal === 'running') return TERMINAL_STATE[this.terminalStatus ?? ''] ?? 'idle'
    if (this.shell) return 'running'
    return this.run?.state ?? 'idle'
  }

  info(): SessionInfo {
    const facts = modelFacts(this.model)
    return {
      id: this.id,
      cwd: this.cwd,
      title: this.title,
      state: this.state,
      createdAt: this.createdAt,
      lastActivity: this.lastActivity,
      pendingPermissions: this.run?.approvals.size ?? 0,
      live: this.live,
      owned: this.owned,
      model: this.model,
      permissionMode: this.permissionMode,
      terminal: this.terminal,
      contextWindow: facts?.window,
      effort: this.effortChoice ?? facts?.effort ?? undefined,
      usage: this.usage.last,
    }
  }

  /** 内容流的第一条：after 对得上、差得不多就只补差量，否则只发最近一段；最后带上正在生成的那一块 */
  hello(after?: EventId): StreamHello {
    const page = this.buffer.since(after, this.run?.approvals.seqs() ?? [])
    return { epoch: this.epoch, info: this.info(), ...page, live: this.run?.streaming.block ?? null }
  }

  /** seq 为 before 之前的一页 */
  history(before: number): HistoryPage {
    return this.buffer.history(before)
  }

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn)
    return () => {
      this.listeners.delete(fn)
      this.touchedAt = Date.now()
    }
  }

  /**
   * 没有子进程时，把 transcript 里新写的补进缓冲（终端写的、子进程被回收前最后写的）。
   * 从缓冲里最后一条主链消息往后接；transcript 里找不到它（压缩过、终端里回退过）就换 epoch 整段重建。
   * 同一时刻只跑一个
   */
  sync(): Promise<void> {
    this.syncing ??= this.doSync()
      .catch((e) => console.error(`[session ${this.id.slice(0, 8)}] 读 transcript 失败`, e))
      .finally(() => (this.syncing = undefined))
    return this.syncing
  }

  private async doSync() {
    if (this.live || this.resumeAt || this.shell) return
    const meta = await getSessionInfo(this.id)
    if (!meta) return // 还没写出 transcript
    this.setTitle(titleOf(meta))
    const stamp = `${meta.fileSize}:${meta.lastModified}`
    if (stamp === this.stamp) return
    const entries = await readTranscript(this.id)
    // 等待期间起了子进程：以 SDK 流为准，下次回收后再对
    if (this.live) return
    this.stamp = stamp
    const { lastUuid } = this.buffer
    const from = lastUuid ? entries.findIndex((e) => e.uuid === lastUuid) + 1 : 0
    if (from === 0 && this.lastSeq) {
      console.log(`[session ${this.id.slice(0, 8)}] 与 transcript 对不上，整段重建`)
      return this.reset(entries)
    }
    for (const e of entries.slice(from)) {
      this.buffer.lastUuid = e.uuid
      if (e.ev) this.push(e.ev, e.at)
    }
  }

  /** 换 epoch，按 transcript 重建缓冲；看着的手机收到新的 hello 后丢掉手里的重来 */
  private reset(entries: TranscriptEntry[]) {
    this.buffer.clear()
    for (const e of entries) {
      this.buffer.lastUuid = e.uuid
      if (e.ev) this.record(e.ev, e.at)
    }
    this.broadcast({ event: 'hello', data: this.hello() })
    this.onChange()
  }

  /** 登记表扫描的结果：h 是持有这个会话的终端进程 */
  setHolder(h: Holder | undefined) {
    if (h) {
      const changed = this.terminal !== 'running' || this.terminalStatus !== h.status
      this.terminal = 'running'
      this.terminalStatus = h.status
      // 终端 resume 的是整条链，回退作废；它写的从截断处接着补
      this.resumeAt = undefined
      const active = h.updatedAt > this.lastActivity
      if (active) this.lastActivity = h.updatedAt
      if (changed) this.emitState()
      else if (active) this.onChange()
      // 没人看时不 sync，标题（终端自动起的、/rename 的）跟着终端状态变化刷一下：/clear 刚换上的新会话一开始只有 /clear
      if (changed && !this.watched)
        void getSessionInfo(this.id).then(
          (m) => m && this.setTitle(titleOf(m)),
          () => {},
        )
    } else if (this.terminal === 'running') {
      // 终端退出了，或 /clear 换了新会话：这个 id 没人占着，就是普通的历史会话，发消息直接 resume
      this.terminal = undefined
      this.terminalStatus = undefined
      this.emitState()
      // 终端放手前最后写的几条
      if (this.watched) void this.sync()
    }
  }

  private setTitle(title: string | undefined) {
    if (!title || title === this.title) return
    this.title = title
    this.emitState()
  }

  /** 子进程被回收了就先 resume；并发上限、终端是否占着、transcript 是否对齐由 SessionManager 先处理 */
  send(text: string, images: ImageAttachment[] = []) {
    // 命令的输出要排在这条前面
    if (this.shell) throw new ConflictError('命令还在跑，等它跑完或中断')
    const run = this.run ?? this.start()
    // 截断点用这一次就够：这条消息写进 transcript 就从截断处分了叉，之后正常 resume
    this.resumeAt = undefined
    this.owned = true
    const uuid = crypto.randomUUID()
    this.push({ type: 'user_input', text, uuid, ...(images.length && { images: images.length }) })
    run.send(text, uuid, images)
    this.emitState()
  }

  decide(reqId: string, d: PermissionDecisionBody): boolean {
    if (!this.run?.approvals.decide(reqId, d)) return false
    if (d.behavior === 'allow' && d.mode) this.permissionMode = d.mode
    this.push({ type: 'permission_resolved', id: reqId, behavior: d.behavior })
    this.emitState()
    return true
  }

  /** 切权限模式（终端里的 Shift+Tab）。子进程被回收了就先记着，下次起子进程时带上 */
  async setMode(mode: PermissionMode) {
    if (this.terminal) throw new ConflictError('终端会话不能切模式')
    await this.run?.q.setPermissionMode(mode)
    this.permissionMode = mode
    this.emitState()
  }

  /** 切模型、effort（终端里的 /model、/effort），只对本会话。子进程被回收了就先记着，下次起子进程时带上 */
  async setModel(b: SetModelBody) {
    if (this.terminal) throw new ConflictError('终端会话不能切模型')
    if (b.model !== undefined) {
      await this.run?.q.setModel(b.model)
      this.modelChoice = b.model
      this.model = resolveModel(this.cwd, b.model) ?? this.model
    }
    if (b.effort !== undefined) {
      await this.run?.q.applyFlagSettings({ effortLevel: b.effort })
      this.effortChoice = b.effort ?? undefined
    }
    this.emitState()
  }

  /**
   * ! 命令（终端里的 shell 模式）：在会话目录里跑，命令和输出各记一条用户消息，不开始这一轮，下次发消息时 Claude 一起看到。
   * 开始跑就返回；跑的时候状态是 running，中断就停掉命令（停掉的也照样记）。终端是否占着、并发上限由 SessionManager 先处理
   */
  bash(command: string) {
    if (this.terminal) throw new ConflictError('终端会话不能跑命令')
    if (this.state !== 'idle') throw new ConflictError('Claude 还在运行，停下再跑命令')
    const shell = (this.shell = new AbortController())
    this.owned = true
    const input = { text: bashInput(command), uuid: crypto.randomUUID() }
    this.push(fromUserText(input.text, input.uuid)!)
    this.emitState()
    void runShell(command, this.cwd, shell.signal).then((out) => {
      // 会话关掉了
      if (this.shell !== shell) return
      this.shell = undefined
      const output = { text: bashOutput(out), uuid: crypto.randomUUID() }
      const ev = fromUserText(output.text, output.uuid)
      if (ev) this.push(ev)
      // 输出没内容时缓冲里没有这条，transcript 里有，也要记住
      this.buffer.lastUuid = output.uuid
      const run = this.run ?? this.start()
      // 同发消息：写进去就从回退的截断处分了叉
      this.resumeAt = undefined
      run.append(input.text, input.uuid)
      run.append(output.text, output.uuid)
      this.emitState()
    })
  }

  async interrupt() {
    if (this.shell) return this.shell.abort()
    await this.run?.interrupt()
  }

  /**
   * 回退到某条用户消息之前（终端里按两下 Esc），restore 选回退哪样：代码还原成发这条时的样子；对话截到它前一条，缓冲按截过的 transcript 重建。
   * 代码用 rewindFiles，对话在下次起子进程时带 resumeSessionAt。说好的哪样做不了就报错、什么都不动。
   * dryRun 只预览，两样都看。终端是否占着、并发上限由 SessionManager 先处理
   */
  async rewind(uuid: string, restore: RewindRestore, dryRun: boolean): Promise<RewindResult> {
    if (this.terminal) throw new ConflictError('终端会话不能回退')
    if (this.state !== 'idle') throw new ConflictError('Claude 还在运行，停下再回退')
    const kept = keptBefore(await readTranscript(this.id), uuid, this.resumeAt)
    const talk = !dryRun && restore !== 'code'
    if (talk && typeof kept === 'string') throw new ConflictError(kept)

    let files: RewindFilesResult | undefined
    if (dryRun || restore !== 'conversation') {
      // 没子进程就现起一个（检查点 resume 时从 transcript 载入），没发消息收不到 init 会一直是 starting，用完就停
      const fresh = !this.run
      const run = this.run ?? this.start()
      files = await rewindFiles(run.q, uuid, dryRun).finally(() => {
        if (fresh && this.run === run) this.stop()
      })
      if (!dryRun && !files.canRewind) throw new ConflictError(`代码还原不了：${files.error || '这条没留底'}`)
    }
    if (dryRun) return { files, conversationBlocked: typeof kept === 'string' ? kept : undefined }

    if (talk && typeof kept !== 'string') {
      // 对话从截断处重起子进程。截断点只记在内存里，留在标签条上别被清出去
      this.stop()
      this.resumeAt = kept.at(-1)!.uuid
      this.owned = true
      this.reset(kept)
    }
    return { files }
  }

  /** 回收子进程，缓冲留着。只对空闲的会话调用 */
  sleep() {
    if (!this.run) return
    this.stop()
    this.emitState()
  }

  /** 手机上关掉：停子进程、出标签条。transcript 还在，之后能从目录里再打开 */
  dismiss() {
    this.owned = false
    this.close()
    this.emitState()
  }

  /**
   * 删会话之前：子进程正在跑的先中断，等这一轮收尾（中断也要写进 transcript），再停子进程、等它退出，
   * 之后就没有人往 transcript 里写了（! 命令由 close 停掉，输出不再记）。看着的手机收到 deleted。停不下来就报错，什么都不动
   */
  async remove() {
    const busy = () => this.run !== undefined && this.run.state !== 'idle'
    if (busy()) {
      // 中断失败多半是子进程已经没了，下面照样等它
      await this.run!.interrupt().catch(() => {})
      for (let i = 0; i < 100 && busy(); i++) await Bun.sleep(100)
      if (busy()) throw new ConflictError('Claude 停不下来，稍后再删')
    }
    const run = this.run
    this.close()
    this.broadcast({ event: 'deleted', data: null })
    if (run) await Promise.race([run.ended, Bun.sleep(10_000)])
  }

  /** 服务端退出。正在跑的命令也停掉、不再记 */
  close() {
    this.shell?.abort()
    this.shell = undefined
    this.stop()
  }

  emitState() {
    this.broadcast({ event: 'state', data: this.info() })
    this.onChange()
  }

  onLive(u: LiveUpdate) {
    this.broadcast({ event: 'live', data: u })
  }

  /** 子进程自己退出了（崩溃）：会话回到 idle，下次发消息 resume */
  exited(run: Run) {
    if (this.run !== run) return
    this.stop()
    this.emitState()
  }

  private start(): Run {
    const run = new Run(this, {
      id: this.id,
      cwd: this.cwd,
      resume: this.spawned,
      resumeAt: this.resumeAt,
      mode: this.permissionMode,
      model: this.modelChoice,
      effort: this.effortChoice,
    })
    this.run = run
    this.spawned = true
    // 子进程会往 transcript 里写，回收后要重新比对
    this.stamp = undefined
    return run
  }

  /** 停子进程，之后它发来的消息、它的退出都不再理会 */
  private stop() {
    const run = this.run
    this.run = undefined
    run?.close()
  }

  /** 记进缓冲、推给看着的手机，返回 seq。at：transcript 里读出来的用它自己的时间 */
  push(ev: SessionEvent, at?: number): number {
    const usage = this.usage.last
    const env = this.record(ev, at)
    this.broadcast({ event: 'ev', data: env })
    // 状态栏的 ctx、cache 跟着变
    if (this.usage.last !== usage) this.emitState()
    else this.onChange()
    return env.seq
  }

  private record(ev: SessionEvent, at = Date.now()): EventEnvelope {
    const env = this.buffer.add(ev, at)
    if (at > this.lastActivity) this.lastActivity = at
    if (ev.type === 'sdk' && ev.msg.type === 'assistant' && !ev.msg.parent_tool_use_id) {
      const { message } = ev.msg
      this.usage.update(message, at)
      // transcript 里读出来的没有 init，模型从 assistant 消息取（中断、出错时补的合成消息不算）
      if (!this.live && message.model !== '<synthetic>') this.model = message.model
    }
    return env
  }

  private broadcast(msg: StreamMsg) {
    for (const fn of this.listeners) {
      try {
        fn(msg)
      } catch (e) {
        console.error('[session] listener error', e)
      }
    }
  }
}
