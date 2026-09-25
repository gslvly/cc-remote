import {
  getSessionInfo,
  query,
  type CanUseTool,
  type PermissionMode,
  type PermissionResult,
  type Query,
  type SDKMessage,
} from '@anthropic-ai/claude-agent-sdk'
import type {
  EventEnvelope,
  HistoryPage,
  LiveUpdate,
  PermissionDecisionBody,
  SessionEvent,
  SessionInfo,
  SessionState,
  StreamHello,
} from '../shared/protocol'
import { EventBuffer, type EventId } from './buffer'
import { childEnv, InputQueue } from './child'
import { LiveTracker } from './live'
import { type Pending, permissionRequest, permissionResult } from './permission'
import { pusher } from './push'
import { slim } from './slim'
import type { Holder } from './terminal'
import { readTranscript, titleOf, type TranscriptEntry } from './transcript'
import { learn, learnWindows, modelFacts, quota, UsageTracker } from './usage'

export type { EventId }

export type StreamMsg =
  | { event: 'hello'; data: StreamHello }
  | { event: 'ev'; data: EventEnvelope }
  | { event: 'live'; data: LiveUpdate }
  | { event: 'state'; data: SessionInfo }
type Listener = (msg: StreamMsg) => void

/** 一个活着的 claude 子进程 */
interface Run {
  q: Query
  input: InputQueue
}

/** 登记表里终端进程的 status → 会话状态。waiting 是终端在等人操作（审批、回答），手机上只能看 */
const TERMINAL_STATE: Record<string, SessionState> = { busy: 'running', shell: 'running', waiting: 'requires_action', idle: 'idle' }

/** 终端还占着这个会话，或者终端退出后还没接管 */
export class ConflictError extends Error {}

/**
 * 一个会话：手机上开的（托管）、从目录页打开的历史会话、终端里正在跑的，都是它。
 * - 事件缓冲跟着会话走，子进程可以随时回收：回收后状态仍是 idle，下次发消息时 resume，epoch 和 seq 都接着用，手机端察觉不到。
 * - 没有子进程时，缓冲与 transcript 对齐（sync）：历史会话打开时整段载入，终端会话在手机看着时跟着 transcript 追加。
 *   SDK 流里消息的 uuid 与 transcript 一致，发给 SDK 的用户消息也指定了 uuid，所以从缓冲里最后一条接着补就不会重复
 */
export class Session {
  /** 加进本服务端的时间（标签按它排） */
  readonly createdAt = Date.now()
  lastActivity: number
  title: string
  model?: string
  permissionMode?: PermissionMode
  /** 手机上开的、在手机上发过消息的、接管过的：进标签条 */
  owned = false
  terminal?: 'running' | 'exited'
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
  /** 正在生成的那一块，不进缓冲 */
  private streaming = new LiveTracker((u) => this.broadcast({ event: 'live', data: u }))
  private pending = new Map<string, Pending>()
  private run?: Run
  /** 起过子进程了：再起就 resume，不再用 sessionId 新建 */
  private spawned = false
  /** 当前子进程收到过 init */
  private started = false
  private turnRunning = false

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

  get state(): SessionState {
    if (this.terminal === 'running') return TERMINAL_STATE[this.terminalStatus ?? ''] ?? 'idle'
    if (this.pending.size > 0) return 'requires_action'
    if (this.run && !this.started) return 'starting'
    return this.turnRunning ? 'running' : 'idle'
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
      pendingPermissions: this.pending.size,
      live: this.live,
      model: this.model,
      permissionMode: this.permissionMode,
      terminal: this.terminal,
      contextWindow: facts?.window,
      effort: facts?.effort ?? undefined,
      usage: this.usage.last,
    }
  }

  /** 内容流的第一条：after 对得上、差得不多就只补差量，否则只发最近一段；最后带上正在生成的那一块 */
  hello(after?: EventId): StreamHello {
    // 还在等批准的请求要包含进去，不然手机上弹不出审批
    const page = this.buffer.since(after, [...this.pending.values()].map((p) => p.seq))
    return { epoch: this.epoch, info: this.info(), ...page, live: this.streaming.block }
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
    if (this.live) return
    const meta = await getSessionInfo(this.id)
    if (!meta) return // 还没写出 transcript
    const title = titleOf(meta)
    if (title && title !== this.title) {
      this.title = title
      this.emitState()
    }
    const stamp = `${meta.fileSize}:${meta.lastModified}`
    if (stamp === this.stamp) return
    const entries = await readTranscript(this.id)
    // 等待期间起了子进程：以 SDK 流为准，下次回收后再对
    if (this.live) return
    this.stamp = stamp
    const { lastUuid } = this.buffer
    const from = lastUuid ? entries.findIndex((e) => e.uuid === lastUuid) + 1 : 0
    if (from === 0 && this.lastSeq) return this.reset(entries)
    for (const e of entries.slice(from)) {
      this.buffer.lastUuid = e.uuid
      if (e.ev) this.push(e.ev, e.at)
    }
  }

  /** 换 epoch，按 transcript 重建缓冲；看着的手机收到新的 hello 后丢掉手里的重来 */
  private reset(entries: TranscriptEntry[]) {
    console.log(`[session ${this.id.slice(0, 8)}] 与 transcript 对不上，整段重建`)
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
      const active = h.updatedAt > this.lastActivity
      if (active) this.lastActivity = h.updatedAt
      if (changed) this.emitState()
      else if (active) this.onChange()
    } else if (this.terminal === 'running') {
      // 手机正看着的，显示「接管」让人确认；没人看的就是普通的历史会话，发消息直接 resume
      this.terminal = this.watched ? 'exited' : undefined
      this.terminalStatus = undefined
      this.emitState()
      // 终端退出前最后写的几条
      if (this.watched) void this.sync()
    }
  }

  /** 接管终端退出后留下的会话：之后就是托管会话，发消息时 resume */
  adopt() {
    this.terminal = undefined
    this.owned = true
    this.emitState()
  }

  /** 子进程被回收了就先 resume；并发上限、终端是否占着、transcript 是否对齐由 SessionManager 先处理 */
  send(text: string) {
    const run = this.run ?? this.start()
    this.owned = true
    // 指定 uuid：transcript 里这条消息就用它，与 transcript 对齐时认得出来
    const uuid = crypto.randomUUID()
    this.push({ type: 'user_input', text, uuid })
    run.input.push({
      type: 'user',
      uuid,
      message: { role: 'user', content: text },
      parent_tool_use_id: null,
      origin: { kind: 'human' },
      session_id: this.id,
    })
    this.turnRunning = true
    this.emitState()
  }

  decide(reqId: string, d: PermissionDecisionBody): boolean {
    const p = this.pending.get(reqId)
    if (!p) return false
    this.pending.delete(reqId)
    p.resolve(permissionResult(p, d))
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

  async interrupt() {
    for (const [id, p] of this.pending) {
      p.resolve({ behavior: 'deny', message: 'Interrupted by user.', interrupt: true })
      this.pending.delete(id)
      this.push({ type: 'permission_resolved', id, behavior: 'cancelled' })
    }
    this.emitState()
    await this.run?.q.interrupt()
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
    this.stop()
    this.emitState()
  }

  /** 服务端退出 */
  close() {
    this.stop()
  }

  emitState() {
    this.broadcast({ event: 'state', data: this.info() })
    this.onChange()
  }

  private start(): Run {
    const input = new InputQueue()
    const q = query({
      prompt: input,
      options: {
        cwd: this.cwd,
        // 第一次用预生成的 id 新建；子进程回收或退出后再发消息，就 resume 接着聊（不会重放旧消息）
        ...(this.spawned ? { resume: this.id } : { sessionId: this.id }),
        env: childEnv(),
        // 不传时 SDK 发的是空系统提示词，与终端不一致
        systemPrompt: { type: 'preset', preset: 'claude_code' },
        // 手机上选过、切过的模式；子进程回收后 resume 也接着用。没有就由 Claude Code 自己定
        ...(this.permissionMode && { permissionMode: this.permissionMode }),
        // 逐字蹦出：增量由 LiveTracker 合并，不进缓冲
        includePartialMessages: true,
        canUseTool: this.canUseTool,
        stderr: (s) => console.error(`[claude ${this.id.slice(0, 8)}] ${s.trimEnd()}`),
      },
    })
    const run: Run = { q, input }
    this.run = run
    this.spawned = true
    this.started = false
    // 子进程会往 transcript 里写，回收后要重新比对
    this.stamp = undefined
    void this.pump(run)
    return run
  }

  private stop() {
    const run = this.run
    if (!run) return
    this.detach()
    run.input.close()
    run.q.close()
  }

  /** 与当前子进程脱钩：之后它发来的消息、它的退出都不再理会 */
  private detach() {
    this.run = undefined
    this.started = false
    this.turnRunning = false
    this.streaming.clear()
    for (const [id, p] of this.pending) {
      p.resolve({ behavior: 'deny', message: 'Session ended.' })
      this.push({ type: 'permission_resolved', id, behavior: 'cancelled' })
    }
    this.pending.clear()
  }

  private canUseTool: CanUseTool = (toolName, input, opts) =>
    new Promise<PermissionResult>((resolve) => {
      const req = permissionRequest(toolName, input, opts)
      const { id } = req
      this.push({ type: 'permission_request', req })
      this.pending.set(id, { req, input, resolve, seq: this.lastSeq })
      this.emitState()
      pusher.approval(this, req)

      opts.signal.addEventListener('abort', () => {
        if (!this.pending.delete(id)) return
        resolve({ behavior: 'deny', message: 'Aborted.' })
        this.push({ type: 'permission_resolved', id, behavior: 'cancelled' })
        this.emitState()
      })
    })

  private async pump(run: Run) {
    try {
      for await (const msg of run.q) {
        if (this.run !== run) break
        this.onMessage(msg)
      }
    } catch (e) {
      if (this.run === run) this.push({ type: 'error', message: e instanceof Error ? e.message : String(e) })
    }
    // 自己回收的，detach 已经做过了；子进程自己退出（崩溃）的，会话回到 idle，下次发消息 resume
    if (this.run !== run) return
    run.input.close()
    this.detach()
    this.emitState()
  }

  private onMessage(msg: SDKMessage) {
    // 增量和思考进度只更新快照。子代理不发增量（实测），这里也不收它的
    if (msg.type === 'stream_event') {
      if (!msg.parent_tool_use_id) this.streaming.onStream(msg.event)
      return
    }
    if (msg.type === 'system' && msg.subtype === 'thinking_tokens') {
      this.streaming.onThinkingTokens(msg.estimated_tokens)
      return
    }
    // 额度是全账号的，另外记一份（概览流推给首页、各会话的状态栏）
    if (msg.type === 'rate_limit_event') {
      quota.fromEvent(msg.rate_limit_info)
      pusher.rateLimit(this, msg.rate_limit_info)
    }
    let stateChanged = false
    if (msg.type === 'system' && msg.subtype === 'init') {
      // 流式输入时每一轮都会发一次 init
      this.started = true
      this.model = msg.model
      this.permissionMode = msg.permissionMode
      stateChanged = true
      // 状态栏的上下文上限、effort：每轮问一次（/effort、/model 会改）。问到的有变化，各会话都会重新推状态
      if (this.run) void learn(this.run.q, msg.model).catch((e) => console.warn(`[session ${this.id.slice(0, 8)}] 取模型信息失败`, e))
    }
    if (msg.type === 'system' && msg.subtype === 'status' && msg.permissionMode) {
      this.permissionMode = msg.permissionMode
      stateChanged = true
    }
    if (msg.type === 'result') {
      learnWindows(msg.modelUsage)
      if (!msg.queued_turn_count) {
        this.turnRunning = false
        stateChanged = true
        pusher.done(this, msg)
      }
    }
    // 这一块生成完了（中断时是半截的），由完整消息替换快照
    if ((msg.type === 'assistant' && !msg.parent_tool_use_id) || msg.type === 'result') this.streaming.settle()
    this.push({ type: 'sdk', msg: slim(msg) })
    if (stateChanged) this.emitState()
  }

  /** at：transcript 里读出来的用它自己的时间 */
  private push(ev: SessionEvent, at?: number) {
    const usage = this.usage.last
    const env = this.record(ev, at)
    this.broadcast({ event: 'ev', data: env })
    // 状态栏的 ctx、cache 跟着变
    if (this.usage.last !== usage) this.emitState()
    else this.onChange()
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
