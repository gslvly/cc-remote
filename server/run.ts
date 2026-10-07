// 一个活着的 claude 子进程。跟着它生死的都在这：流式输入、SDK 消息的解读、正在生成的那一块、等批准的审批、这一轮在不在跑。
// 子进程停了（回收、崩溃）这些就都没了；事件缓冲、模型和权限模式在 Session 里，经 RunHost 交过去
import { type PermissionMode, query, type Query, type SDKMessage } from '@anthropic-ai/claude-agent-sdk'
import type { UUID } from 'node:crypto'
import type { ImageAttachment, LiveUpdate, SessionEvent, SessionState } from '../shared/protocol'
import { learnCatalog, updateCommands } from './catalog'
import { InputQueue, type SpawnArgs, spawnOptions } from './child'
import { LiveTracker } from './live'
import { Approvals } from './permission'
import { pusher } from './push'
import { slim } from './slim'
import { learn, learnWindows, quota } from './usage'

/** Run 要会话做的（Session 实现） */
export interface RunHost {
  readonly id: string
  readonly cwd: string
  readonly title: string
  /** init、status 报的，Run 直接写 */
  model?: string
  permissionMode?: PermissionMode
  /** 手机上切过 effort：问到的是本会话的，不记成这个模型的 */
  readonly effortChosen: boolean
  /** 记进事件缓冲、推给看着的手机，返回 seq */
  push(ev: SessionEvent): number
  /** 快照的变化，推给看着的手机 */
  onLive(u: LiveUpdate): void
  emitState(): void
  /** 子进程自己退出了（崩溃） */
  exited(run: Run): void
}

export class Run {
  readonly q: Query
  private input = new InputQueue()
  /** 收到过 init（流式输入时每一轮都发一次） */
  private started = false
  private turnRunning = false
  /** append 了、还没收到 result 的 */
  private appended = new Set<string>()
  /** 停掉了：之后它发来的消息、它的退出都不再理会 */
  private closed = false
  /** 正在生成的那一块，不进缓冲 */
  readonly streaming: LiveTracker
  readonly approvals: Approvals
  /** 子进程退出了（消息流读到底，见 pump） */
  readonly ended: Promise<void>

  constructor(
    private host: RunHost,
    args: Omit<SpawnArgs, 'canUseTool'>,
  ) {
    this.streaming = new LiveTracker((u) => host.onLive(u))
    this.approvals = new Approvals({
      requested: (req) => {
        const seq = host.push({ type: 'permission_request', req })
        host.emitState()
        pusher.approval(host, req)
        return seq
      },
      cancelled: (id) => {
        host.push({ type: 'permission_resolved', id, behavior: 'cancelled' })
        host.emitState()
      },
    })
    this.q = query({ prompt: this.input, options: spawnOptions({ ...args, canUseTool: this.approvals.canUseTool }) })
    this.ended = this.pump()
  }

  get state(): SessionState {
    if (this.approvals.size > 0) return 'requires_action'
    if (!this.turnRunning) return 'idle'
    return this.started ? 'running' : 'starting'
  }

  /** 一轮输入。指定 uuid：transcript 里这条消息就用它，与 transcript 对齐时认得出来 */
  send(text: string, uuid: UUID, images: ImageAttachment[] = []) {
    // 图片在前、文字在后（终端贴图也是这样）；API 不收空的 text block
    const content = images.length
      ? [
          ...images.map((i) => ({ type: 'image' as const, source: { type: 'base64' as const, media_type: i.mediaType, data: i.data } })),
          ...(text ? [{ type: 'text' as const, text }] : []),
        ]
      : text
    this.input.push({
      type: 'user',
      uuid,
      message: { role: 'user', content },
      parent_tool_use_id: null,
      origin: { kind: 'human' },
      session_id: this.host.id,
    })
    this.turnRunning = true
  }

  /**
   * 只写进对话、不开始这一轮（! 命令的输入和输出），下次发消息时一起交给 Claude。
   * CLI 照样每条回一个 init 和一个 0 轮的 result（user_message_uuid 是这条），result 不进缓冲、不算一轮
   */
  append(text: string, uuid: UUID) {
    this.appended.add(uuid)
    this.input.push({
      type: 'user',
      uuid,
      message: { role: 'user', content: text },
      parent_tool_use_id: null,
      shouldQuery: false,
      session_id: this.host.id,
    })
  }

  /** 中断这一轮，等批准的都作废 */
  async interrupt() {
    this.approvals.cancelAll({ behavior: 'deny', message: 'Interrupted by user.', interrupt: true })
    await this.q.interrupt()
  }

  /** 停掉子进程，等批准的都作废 */
  close() {
    this.closed = true
    this.turnRunning = false
    this.streaming.clear()
    this.approvals.cancelAll({ behavior: 'deny', message: 'Session ended.' })
    this.input.close()
    this.q.close()
  }

  /** 停掉之后也读到底（不理会），读完就是子进程退出了，ended 靠它 */
  private async pump() {
    try {
      for await (const msg of this.q) if (!this.closed) this.onMessage(msg)
    } catch (e) {
      if (!this.closed) this.host.push({ type: 'error', message: e instanceof Error ? e.message : String(e) })
    }
    // 自己停的不用管；子进程自己退出（崩溃）的交给会话：回到 idle，下次发消息 resume
    if (!this.closed) this.host.exited(this)
  }

  private onMessage(msg: SDKMessage) {
    const host = this.host
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
      pusher.rateLimit(host, msg.rate_limit_info)
    }
    if (msg.type === 'result' && this.ownAppend(msg.user_message_uuids ?? [])) return
    let stateChanged = false
    if (msg.type === 'system' && msg.subtype === 'init') {
      const warn = (what: string) => (e: unknown) => console.warn(`[session ${host.id.slice(0, 8)}] 取${what}失败`, e)
      // 斜杠命令、模型列表：子进程起来后问一次
      if (!this.started) void learnCatalog(host.cwd, this.q).catch(warn('命令列表'))
      this.started = true
      host.model = msg.model
      host.permissionMode = msg.permissionMode
      stateChanged = true
      // 状态栏的上下文上限、effort：每轮问一次（/effort、/model 会改）。问到的有变化，各会话都会重新推状态
      void learn(this.q, msg.model, !host.effortChosen).catch(warn('模型信息'))
    }
    if (msg.type === 'system' && msg.subtype === 'commands_changed') updateCommands(host.cwd, msg.commands)
    if (msg.type === 'system' && msg.subtype === 'status' && msg.permissionMode) {
      host.permissionMode = msg.permissionMode
      stateChanged = true
    }
    if (msg.type === 'result') {
      learnWindows(msg.modelUsage)
      if (!msg.queued_turn_count) {
        this.turnRunning = false
        stateChanged = true
        pusher.done(host, msg)
      }
    }
    // 这一块生成完了（中断时是半截的），由完整消息替换快照
    if ((msg.type === 'assistant' && !msg.parent_tool_use_id) || msg.type === 'result') this.streaming.settle()
    host.push({ type: 'sdk', msg: slim(msg) })
    if (stateChanged) host.emitState()
  }

  /** 这个 result 只是 append 的回执。和真消息并成一轮的（排在它后面马上发了）不算 */
  private ownAppend(uuids: string[]): boolean {
    const own = uuids.length > 0 && uuids.every((u) => this.appended.has(u))
    for (const u of uuids) this.appended.delete(u)
    return own
  }
}
