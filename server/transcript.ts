// 读 transcript（Claude Code 自己写的会话记录），转成会话事件：历史会话和终端会话的内容都从这里来。
// 用 SDK 的 getSessionMessages：它按 parentUuid 串出主链（只含最近一次压缩之后的部分），与 resume 看到的一致
import { getSessionMessages, type SDKMessage, type SDKSessionInfo, type SessionMessage } from '@anthropic-ai/claude-agent-sdk'
import type { SessionEvent } from '../shared/protocol'
import { slim } from './slim'

/**
 * 会话标题：/rename 的或终端自动生成的（customTitle 两样都含），没有就用第一句。
 * 不用 summary：没标题时它取最后一句，SDK 起的会话（手机上开的）一直没标题，列表里就跟着最后一句变
 */
export const titleOf = (s: SDKSessionInfo) => s.customTitle || s.firstPrompt || s.summary

/** /clear 之后什么都没做留下的空会话 */
export const isEmpty = (s: SDKSessionInfo) => s.summary === '/clear'

/** 主链上的一条消息。转不成事件的（meta 消息、系统包装）ev 为空，但 uuid 照样用来对齐 */
export interface TranscriptEntry {
  uuid: string
  at: number
  ev?: SessionEvent
}

/** 类型里没写、运行时带着的字段 */
type Raw = SessionMessage & {
  timestamp?: string
  is_meta?: boolean
  isMeta?: boolean
  isCompactSummary?: boolean
}

type Block = { type?: string; text?: unknown }

const ANSI = /\x1b\[[0-9;]*m/g
const tag = (s: string, name: string) => s.match(new RegExp(`<${name}>([\\s\\S]*?)</${name}>`))?.[1]

export async function readTranscript(id: string): Promise<TranscriptEntry[]> {
  // system 消息读出来只剩 uuid 和时间，看不出是什么，不要
  const msgs = (await getSessionMessages(id)) as Raw[]
  return msgs.map((m) => ({ uuid: m.uuid, at: Date.parse(m.timestamp ?? '') || 0, ev: toEvent(m) }))
}

/**
 * SDK 流里的 assistant / user 消息原样进缓冲，这里拼成同样的形状；只有人输入的那条换成 user_input
 * （SDK 不回显用户消息，托管会话里它是服务端自己记的）
 */
function toEvent(m: Raw): SessionEvent | undefined {
  // 压缩摘要同时也是 meta 消息，先认出来
  if (m.isCompactSummary) return { type: 'note', text: '（更早的对话已压缩）' }
  if (m.is_meta || m.isMeta || m.parent_tool_use_id) return
  const sdk = (): SessionEvent => ({
    type: 'sdk',
    msg: slim({ type: m.type, message: m.message, parent_tool_use_id: null, uuid: m.uuid, session_id: m.session_id } as SDKMessage),
  })
  if (m.type === 'assistant') return sdk()
  if (m.type !== 'user') return

  const content = (m.message as { content?: unknown } | undefined)?.content
  const blocks: Block[] = typeof content === 'string' ? [{ type: 'text', text: content }] : Array.isArray(content) ? content : []
  if (blocks.some((b) => b.type === 'tool_result')) return sdk()
  const text = blocks
    .map((b) => (b.type === 'text' ? String(b.text) : b.type === 'image' ? '[图片]' : ''))
    .filter(Boolean)
    .join('\n')
  if (!text.trim() || text.startsWith('<local-command-caveat>') || text.startsWith('<system-reminder>')) return
  if (text.startsWith('[Request interrupted')) return sdk()

  // 终端里的斜杠命令、! 命令、本地命令的输出、后台任务通知：CLI 用标签包起来写进 transcript
  const cmd = tag(text, 'command-name')
  if (cmd !== undefined) {
    const args = tag(text, 'command-args')?.trim()
    return { type: 'user_input', text: args ? `${cmd} ${args}` : cmd, uuid: m.uuid }
  }
  const bash = tag(text, 'bash-input')
  if (bash !== undefined) return { type: 'user_input', text: `! ${bash}`, uuid: m.uuid }
  const out = [tag(text, 'local-command-stdout'), tag(text, 'bash-stdout'), tag(text, 'bash-stderr')]
  if (out.some((o) => o !== undefined)) {
    const s = out.filter(Boolean).join('\n').replace(ANSI, '').trim()
    return s ? { type: 'note', text: s } : undefined
  }
  if (text.startsWith('<task-notification>')) {
    const summary = tag(text, 'summary')
    return summary ? { type: 'note', text: `后台任务：${summary.trim()}` } : undefined
  }
  return { type: 'user_input', text, uuid: m.uuid }
}
