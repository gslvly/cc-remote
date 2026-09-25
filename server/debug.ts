// 调试、测试用：一条会话事件压成一行文字（单测断言、scripts/inspect.ts、e2e 输出共用）
import type { SessionEvent } from '../shared/protocol'

const cut = (s: string, n = 100) => {
  const one = s.replace(/\s*\n\s*/g, '⏎')
  return one.length > n ? `${one.slice(0, n)}…` : one
}

export function eventLine(ev: SessionEvent): string {
  switch (ev.type) {
    case 'user_input':
      return `> ${cut(ev.text)}`
    case 'note':
      return `note ${cut(ev.text)}`
    case 'error':
      return `error ${cut(ev.message)}`
    case 'permission_request':
      return `? ${ev.req.toolName}`
    case 'permission_resolved':
      return `permission ${ev.behavior}`
  }
  const m = ev.msg as { type: string; subtype?: string; message?: { content?: unknown } }
  const blocks = Array.isArray(m.message?.content) ? (m.message.content as { type: string; text?: string; name?: string }[]) : []
  if (m.type === 'assistant') return blocks.map((b) => (b.type === 'text' ? cut(b.text ?? '') : b.type === 'tool_use' ? `[${b.name}]` : `[${b.type}]`)).join(' ')
  if (m.type === 'user') return blocks.map((b) => `[${b.type}]`).join(' ') || 'user'
  return m.subtype ? `${m.type}:${m.subtype}` : m.type
}

/** 内容流（SSE）的一条消息压成一行：hello 只记条数（e2e 的 events()、scripts/api.ts 共用） */
export function streamLine(event: string, data: any): string {
  return event === 'ev'
    ? `${data.seq} ${eventLine(data.ev)}`
    : event === 'hello'
      ? `hello ${data.epoch}${data.reset ? ' reset' : ''} ${data.events.length} 条`
      : event === 'state'
        ? `state ${data.state}${data.terminal ? ` 终端 ${data.terminal}` : ''}`
        : event
}
