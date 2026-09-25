// 会话内容的缓存：最近看过的几个会话留在内存里，切回来只补差量。
// 内容流只连正在看的那个会话，切走就断开（服务端照常跑、照常缓冲）
import { type Accessor, batch, createSignal } from 'solid-js'
import { createStore, reconcile, unwrap } from 'solid-js/store'
import type {
  EventEnvelope,
  HistoryPage,
  LiveBlock,
  LiveUpdate,
  PermissionDecisionBody,
  SessionInfo,
  SetModeBody,
  StreamHello,
  SwitchableMode,
} from '../../../shared/protocol'
import { api } from '../api'
import { type Conn, openStream, type Stream } from '../sse'
import { applyEvents, emptyView, type View } from './view'

/** 内存里最多留几个会话 */
const KEEP = 3

/** 主链的完整 assistant 消息、result：正在生成的那一块有了正式版本，快照作废（服务端同样处理） */
const settles = ({ ev }: EventEnvelope) =>
  ev.type === 'sdk' && ((ev.msg.type === 'assistant' && !ev.msg.parent_tool_use_id) || ev.msg.type === 'result')

export interface SessionStore {
  view: View
  /** 正在生成的那一块，接在 view.items 后面显示 */
  live: Accessor<LiveBlock | null>
  info: Accessor<SessionInfo | null>
  conn: Accessor<Conn>
  /** 服务端还有更早的事件没取 */
  more: Accessor<boolean>
  loadingOlder: Accessor<boolean>
  loadOlder(): Promise<void>
  /** 断开内容流，内容留在缓存里 */
  detach(): void
  actions: {
    send(text: string): Promise<unknown>
    decide(reqId: string, d: PermissionDecisionBody): Promise<unknown>
    interrupt(): Promise<unknown>
    /** 切权限模式 */
    setMode(mode: SwitchableMode): Promise<unknown>
    /** 接管终端退出后留下的会话 */
    takeover(): Promise<unknown>
    /** 关掉：停子进程、出标签条 */
    close(): Promise<unknown>
  }
}

// Map 按插入顺序，最后一个是最近看的
const cache = new Map<string, SessionStore & { attach(): void }>()

/** 打开一个会话：有缓存就接着用，连上内容流。组件销毁时调 detach */
export function openSession(id: string): SessionStore {
  const s = cache.get(id) ?? createEntry(id)
  cache.delete(id)
  cache.set(id, s)
  for (const old of cache.keys()) {
    if (cache.size <= KEEP) break
    cache.delete(old)
  }
  s.attach()
  return s
}

function createEntry(id: string) {
  const [view, setView] = createStore<View>(emptyView())
  const [live, setLive] = createSignal<LiveBlock | null>(null)
  const [info, setInfo] = createSignal<SessionInfo | null>(null)
  const [conn, setConn] = createSignal<Conn>('connecting')
  const [more, setMore] = createSignal(false)
  const [loadingOlder, setLoadingOlder] = createSignal(false)
  /** 手里的全部事件，按 seq 升序。往前补了一页后要从头重新归约（工具结果要配上更早的调用） */
  let events: EventEnvelope[] = []
  let stream: Stream | undefined

  // view.ts 按不可变方式算出新 view，再按 key 合并进 store：没变的条目连 DOM 都不动，
  // 工具的状态、输出这类字段原地更新（展开着的工具详情不会因此收起）
  const update = (fn: (v: View) => View) => setView(reconcile(fn(unwrap(view)), { key: 'key' }))
  const rebuild = (epoch: string) => update(() => applyEvents(emptyView(epoch), events))
  // 完整消息和清掉快照放在一批里，替换时不会闪一下、也不会重复一帧
  const append = (envs: EventEnvelope[]) => {
    const fresh = envs.filter((e) => e.seq > view.lastSeq)
    if (!fresh.length) return
    events.push(...fresh)
    batch(() => {
      update((v) => applyEvents(v, fresh))
      if (fresh.some(settles)) setLive(null)
    })
  }

  // 先补断开期间完成的事件，再换上当前快照
  const onHello = (data: string) => {
    const hello: StreamHello = JSON.parse(data)
    batch(() => {
      setInfo(hello.info)
      if (hello.reset || hello.epoch !== view.epoch) {
        events = hello.events
        setMore(hello.more)
        rebuild(hello.epoch)
      } else append(hello.events)
      setLive(hello.live)
    })
  }

  const onLive = (u: LiveUpdate) => {
    if (u.op === 'set') return setLive(u.block)
    // 已经被完整消息替换掉的块不再追加；hello 里的快照可能已经含有这一段，按 at 去掉重叠的部分
    const cur = live()
    if (cur?.kind !== 'text' || cur.id !== u.id || u.at > cur.text.length) return
    const add = u.text.slice(cur.text.length - u.at)
    if (add) setLive({ ...cur, text: cur.text + add })
  }

  const attach = () => {
    stream ??= openStream({
      url: () => `/api/sessions/${id}/events${view.epoch ? `?after=${view.epoch}:${view.lastSeq}` : ''}`,
      probe: `/sessions/${id}`,
      on: {
        hello: onHello,
        ev: (d) => append([JSON.parse(d)]),
        live: (d) => onLive(JSON.parse(d)),
        state: (d) => setInfo(JSON.parse(d)),
      },
      onConn: setConn,
    })
  }

  const detach = () => {
    stream?.close()
    stream = undefined
  }

  const loadOlder = async () => {
    const first = events[0]
    if (!first || !more() || loadingOlder()) return
    setLoadingOlder(true)
    try {
      const page = await api<HistoryPage>(`/sessions/${id}/history?before=${first.seq}`)
      // 等待期间重建过（重连拿到了 reset），这一页就对不上了
      if (page.epoch !== view.epoch || events[0] !== first) return
      events = [...page.events, ...events]
      setMore(page.more)
      rebuild(page.epoch)
    } catch (e) {
      console.warn('[session] 加载更早的消息失败', e)
    } finally {
      setLoadingOlder(false)
    }
  }

  const actions = {
    send: (text: string) => api(`/sessions/${id}/messages`, { text }),
    decide: (reqId: string, d: PermissionDecisionBody) => api(`/sessions/${id}/permissions/${reqId}`, d),
    interrupt: () => api(`/sessions/${id}/interrupt`, {}),
    setMode: (mode: SwitchableMode) => api<SessionInfo>(`/sessions/${id}/mode`, { mode } satisfies SetModeBody).then(setInfo),
    // 成功后服务端推 state，输入框随之出现；这里先把返回的 info 用上，不用等
    takeover: () => api<SessionInfo>(`/sessions/${id}/takeover`, {}).then(setInfo),
    close: () => api(`/sessions/${id}/close`, {}),
  }

  return { view, live, info, conn, more, loadingOlder, loadOlder, attach, detach, actions }
}
