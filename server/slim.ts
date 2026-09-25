import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk'

// 工具输出可能很大（读整个文件、长日志），进缓冲前截断
const MAX_STRING = 20_000

export function truncateDeep(v: unknown): unknown {
  if (typeof v === 'string') {
    return v.length > MAX_STRING ? `${v.slice(0, MAX_STRING)}\n…（已截断，原长 ${v.length} 字符）` : v
  }
  if (Array.isArray(v)) return v.map(truncateDeep)
  if (v && typeof v === 'object') {
    const o = v as Record<string, unknown>
    // 图片等二进制内容不转发
    if (o.type === 'image' || o.type === 'document') return { type: o.type, omitted: true }
    return Object.fromEntries(Object.entries(o).map(([k, x]) => [k, truncateDeep(x)]))
  }
  return v
}

/** 进缓冲前瘦身：SDK 流里的消息、从 transcript 读出来的消息都走这里 */
export function slim(msg: SDKMessage): SDKMessage {
  if (msg.type === 'user') {
    // tool_use_result 是结构化的完整输出，渲染暂时用不到，体积又大
    const { tool_use_result: _, ...rest } = msg as typeof msg & { tool_use_result?: unknown }
    return truncateDeep(rest) as SDKMessage
  }
  if (msg.type === 'assistant') {
    // Claude 说的话不截断：蹦字时手机上是全文，完成后替换上来的也得是全文。
    // thinking 的 signature 是给 API 校验用的，体积大，前端用不到
    const content = msg.message.content.map((b) => {
      if (b.type === 'text') return b
      if (b.type === 'thinking') return truncateDeep({ ...b, signature: '' })
      if (b.type === 'redacted_thinking') return { ...b, data: '' }
      return truncateDeep(b)
    }) as typeof msg.message.content
    return { ...msg, message: { ...msg.message, content } }
  }
  return msg
}
