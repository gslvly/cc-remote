// 全部会话：新建、按 id 载入、并发上限与空闲回收、扫终端登记表、概览流
import { getSessionInfo, type PermissionMode } from '@anthropic-ai/claude-agent-sdk'
import type { OverviewSessions } from '../shared/protocol'
import { checkDir } from './fs'
import { ConflictError, Session } from './session'
import { type Holder, scanHolders } from './terminal'
import { titleOf } from './transcript'
import { onFacts } from './usage'

/** 活着的子进程到上限、又都在忙 */
export class LimitError extends Error {}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** 没进标签条、也没人看着的会话，多久不碰就从内存里清掉（下次打开从 transcript 重新载入） */
const EVICT_MS = 10 * 60_000

export class SessionManager {
  private sessions = new Map<string, Session>()
  private loading = new Map<string, Promise<Session | undefined>>()
  private watchers = new Set<(list: OverviewSessions) => void>()
  private flushTimer?: ReturnType<typeof setTimeout>
  /** 最近一次扫登记表的结果：sessionId → 持有它的终端进程 */
  private holders = new Map<string, Holder>()
  private scanning?: Promise<void>
  private ticks = 0
  private timer = setInterval(() => this.tick(), 1000)
  /** 模型的上下文上限、effort 问到了新的：各会话的状态栏都要更新 */
  private offFacts = onFacts(() => {
    for (const s of this.sessions.values()) s.emitState()
  })

  constructor(private opts: { maxLive: number; idleMinutes: number; roots: string[] }) {
    void this.scan()
  }

  create(cwd: string, prompt: string, mode?: PermissionMode): Session {
    this.makeRoom()
    const s = new Session(crypto.randomUUID(), cwd, prompt.trim().split('\n')[0]!.slice(0, 80), this.changed, { fresh: true })
    s.permissionMode = mode
    this.sessions.set(s.id, s)
    s.send(prompt)
    this.changed()
    return s
  }

  /** 在内存里的会话（审批、中断这类只对活着的会话有意义的操作用） */
  get(id: string) {
    return this.sessions.get(id)
  }

  /**
   * 打开一个会话：不在内存里就当历史会话从 transcript 载入（cwd 不在 roots 内的当作不存在）；
   * 没有子进程时顺便与 transcript 对齐，拿到的内容是最新的
   */
  async open(id: string): Promise<Session | undefined> {
    let s = this.sessions.get(id)
    if (!s) {
      if (!UUID.test(id)) return
      if (!this.loading.has(id)) this.loading.set(id, this.load(id).finally(() => this.loading.delete(id)))
      s = await this.loading.get(id)
      if (!s) return
    }
    s.touchedAt = Date.now()
    await s.sync()
    return s
  }

  /** 发消息。子进程被回收了、或者是历史会话，就 resume：先确认终端没占着，把 transcript 里新写的补上 */
  async send(s: Session, text: string) {
    if (!s.live) {
      await this.scan()
      if (s.terminal === 'running') throw new ConflictError('这个会话正在终端里运行，只能旁观')
      if (s.terminal === 'exited') throw new ConflictError('终端刚退出，先接管再发消息')
      await s.sync()
      if (!s.live) this.makeRoom()
    }
    s.send(text)
  }

  /** 接管终端退出后留下的会话。终端还活着时不行：两边同时写会分叉 */
  async takeover(s: Session) {
    await this.scan()
    if (s.terminal === 'running') throw new ConflictError('终端还在运行，退出后才能接管')
    await s.sync()
    s.adopt()
  }

  /** 概览流：托管的会话和终端里正在跑的，按最后活动时间倒序 */
  list(): OverviewSessions {
    return [...this.sessions.values()]
      .filter((s) => s.listed)
      .map((s) => s.info())
      .sort((a, b) => b.lastActivity - a.lastActivity)
  }

  /** 概览流：有变化就推完整列表，攒 200ms 推一次（每个事件都会更新最后活动时间） */
  watch(fn: (list: OverviewSessions) => void): () => void {
    this.watchers.add(fn)
    return () => this.watchers.delete(fn)
  }

  /** 空闲超过 idleMinutes 的回收子进程；没进标签条、也没人看的清出内存 */
  reap(now = Date.now()) {
    for (const [id, s] of this.sessions) {
      if (s.live && s.state === 'idle' && now - s.lastActivity > this.opts.idleMinutes * 60_000) {
        console.log(`[session ${s.id.slice(0, 8)}] 空闲超过 ${this.opts.idleMinutes} 分钟，回收子进程`)
        s.sleep()
      }
      if (!s.listed && !s.live && !s.watched && now - s.touchedAt > EVICT_MS) this.sessions.delete(id)
    }
  }

  closeAll() {
    clearInterval(this.timer)
    this.offFacts()
    for (const s of this.sessions.values()) s.close()
  }

  private async load(id: string): Promise<Session | undefined> {
    const meta = await getSessionInfo(id)
    if (!meta?.cwd) return
    const dir = await checkDir(meta.cwd, this.opts.roots)
    if (!dir.ok) return
    // 等待期间扫登记表时已经加进来了
    const existing = this.sessions.get(id)
    if (existing) return existing
    const s = new Session(id, dir.path, titleOf(meta), this.changed, { fresh: false, lastActivity: meta.lastModified })
    this.sessions.set(id, s)
    s.setHolder(this.holders.get(id))
    return s
  }

  /** 每秒：终端里在跑、手机正看着的会话跟上 transcript；每 2 秒扫一次登记表；每 30 秒回收一次 */
  private tick() {
    this.ticks++
    for (const s of this.sessions.values()) if (s.terminal === 'running' && s.watched) void s.sync()
    if (this.ticks % 2 === 0) void this.scan()
    if (this.ticks % 30 === 0) this.reap()
  }

  /** 扫一遍登记表：更新各会话的终端状态，终端里新开的会话加进来。同一时刻只扫一次 */
  scan(): Promise<void> {
    this.scanning ??= this.doScan()
      .catch((e) => console.error('[terminal] 扫登记表失败', e))
      .finally(() => (this.scanning = undefined))
    return this.scanning
  }

  private async doScan() {
    const holders = await scanHolders((id) => this.sessions.has(id))
    this.holders = holders
    for (const [id, h] of holders) {
      let s = this.sessions.get(id)
      if (s?.live) {
        // 终端里 resume 了一个我们也开着子进程的会话：空闲就让出来，正在跑就等这一轮结束再说
        if (s.state !== 'idle') continue
        console.log(`[session ${id.slice(0, 8)}] 终端里接着用了这个会话，回收子进程`)
        s.sleep()
      }
      if (!s) {
        if (!(await checkDir(h.cwd, this.opts.roots)).ok) continue
        // transcript 写出来之前没东西可看，等下一轮
        const meta = await getSessionInfo(id)
        if (!meta || this.sessions.has(id)) continue
        s = new Session(id, h.cwd, titleOf(meta), this.changed, { fresh: false, lastActivity: meta.lastModified })
        this.sessions.set(id, s)
      }
      s.setHolder(h)
    }
    for (const s of this.sessions.values()) if (!holders.has(s.id)) s.setHolder(undefined)
  }

  /** 要起新的子进程：到上限了就回收空闲最久的，都在忙就报错 */
  private makeRoom() {
    const live = [...this.sessions.values()].filter((s) => s.live)
    if (live.length < this.opts.maxLive) return
    const victim = live.filter((s) => s.state === 'idle').sort((a, b) => a.lastActivity - b.lastActivity)[0]
    if (!victim)
      throw new LimitError(`已有 ${live.length} 个会话在运行（上限 ${this.opts.maxLive}），等其中一个空闲后再试`)
    console.log(`[session ${victim.id.slice(0, 8)}] 到并发上限 ${this.opts.maxLive}，回收空闲最久的这个`)
    victim.sleep()
  }

  private changed = () => {
    this.flushTimer ??= setTimeout(() => {
      this.flushTimer = undefined
      const list = this.list()
      for (const fn of this.watchers) fn(list)
    }, 200)
  }
}
