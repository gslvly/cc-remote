// 一个会话的事件缓冲：已完成的事件按 seq 编号，重连时补差量，首屏只发最近一段，更早的上滑分页
import type { EventEnvelope, HistoryPage, SessionEvent } from '../shared/protocol'

/** 首屏、每页发多少条事件 */
const PAGE = 200

const newEpoch = () => crypto.randomUUID().slice(0, 8)

/** 主链上的 assistant / user 消息（SDK 流里的 uuid 与 transcript 一致），用来与 transcript 对齐 */
function chainUuid(ev: SessionEvent): string | undefined {
  if (ev.type === 'user_input') return ev.uuid
  if (ev.type !== 'sdk') return
  const m = ev.msg
  if ((m.type === 'assistant' || m.type === 'user') && !m.parent_tool_use_id && !('isReplay' in m && m.isReplay)) return m.uuid
}

export interface EventId {
  epoch: string
  seq: number
}

export class EventBuffer {
  /** 只在与 transcript 对不上、整段重建时换 */
  epoch = newEpoch()
  /** 最后一条主链消息的 uuid：与 transcript 对齐时从它后面接着补（转不成事件的 transcript 条目也记） */
  lastUuid?: string
  private events: EventEnvelope[] = []

  get lastSeq() {
    return this.events.length
  }

  add(ev: SessionEvent, at: number): EventEnvelope {
    const env: EventEnvelope = { seq: this.lastSeq + 1, at, ev }
    this.events.push(env)
    this.lastUuid = chainUuid(ev) ?? this.lastUuid
    return env
  }

  /** 整段重建：换 epoch，清空 */
  clear() {
    this.epoch = newEpoch()
    this.events = []
    this.lastUuid = undefined
  }

  /**
   * 内容流开头要发的：after 的 epoch 对得上、差得不多就只补差量；否则只发最近一段，
   * 另外 keep 里的 seq（还在等批准的请求）也要包含进去
   */
  since(after: EventId | undefined, keep: Iterable<number>): { reset: boolean; events: EventEnvelope[]; more: boolean } {
    const last = this.lastSeq
    if (after?.epoch === this.epoch && after.seq <= last && last - after.seq <= PAGE) {
      return { reset: false, events: this.events.slice(after.seq), more: false }
    }
    let start = Math.max(0, last - PAGE)
    for (const seq of keep) start = Math.min(start, seq - 1)
    return { reset: true, events: this.events.slice(start), more: start > 0 }
  }

  /** seq 为 before 之前的一页 */
  history(before: number): HistoryPage {
    const end = Math.min(Math.max(0, before - 1), this.lastSeq)
    const start = Math.max(0, end - PAGE)
    return { epoch: this.epoch, events: this.events.slice(start, end), more: start > 0 }
  }
}
