// 概览流：全部会话的状态、额度，一直连着。首页的会话列表和额度、会话页的标签条和待批准横幅、状态栏的 5h / 7d 都从这里读
import { type Accessor, createSignal } from 'solid-js'
import { createStore, reconcile } from 'solid-js/store'
import type { OverviewSessions, Quota, SessionInfo } from '../../shared/protocol'
import { basename } from './format'
import { openStream, type Stream } from './sse'

const [sessions, setSessions] = createStore<OverviewSessions>([])
const [quota, setQuota] = createSignal<Quota | null>(null)
let stream: Stream | undefined
let dead = false

/** 按最后活动时间倒序。第一次调用时连上；之前因为没登录断掉的（登录后回来），重新连 */
export function useOverview(): OverviewSessions {
  if (!stream || dead) {
    stream?.close()
    dead = false
    stream = openStream({
      url: () => '/api/overview',
      probe: '/sessions',
      on: {
        sessions: (d) => setSessions(reconcile(JSON.parse(d) as OverviewSessions, { key: 'id' })),
        quota: (d) => setQuota(JSON.parse(d) as Quota),
      },
      onConn: (c) => (dead = c === 'gone' || c === 'unauthorized'),
    })
  }
  return sessions
}

/** 额度：概览流推来的（只来自托管会话的 rate_limit_event，服务端重启后要等有会话跑过一轮才有） */
export function useQuota(): Accessor<Quota | null> {
  useOverview()
  return quota
}

/** 标签上显示的名字：目录名；同一目录开了多个会话时，按创建先后加序号 */
export function sessionLabel(s: SessionInfo, all: readonly SessionInfo[]): string {
  const same = all.filter((x) => x.cwd === s.cwd).sort((a, b) => a.createdAt - b.createdAt)
  const name = basename(s.cwd)
  return same.length > 1 ? `${name} ${same.findIndex((x) => x.id === s.id) + 1}` : name
}
