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
 * 回退到 uuid 那条之前，对话留下的条目；回退不了返回原因。
 * resumeAt 是上次回退的截断点：还没发新消息，transcript 里它后面的都已回退掉
 */
export function keptBefore(entries: TranscriptEntry[], uuid: string, resumeAt?: string): TranscriptEntry[] | string {
  const end = resumeAt ? entries.findIndex((e) => e.uuid === resumeAt) + 1 : entries.length
  const i = entries.slice(0, end).findIndex((e) => e.uuid === uuid)
  if (i < 0) return '对话里没有这条（压缩掉的回不去）'
  // resumeSessionAt 要接在一条消息后面
  if (i === 0) return '回不到第一条之前'
  return entries.slice(0, i)
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
    .filter((b) => b.type === 'text')
    .map((b) => String(b.text))
    .join('\n')
  const images = blocks.filter((b) => b.type === 'image').length
  if (images) return { type: 'user_input', text, uuid: m.uuid, images }
  if (text.startsWith('[Request interrupted')) return sdk()
  return fromUserText(text, m.uuid)
}

/**
 * 一条纯文字的用户消息转成事件。终端里的斜杠命令、! 命令、本地命令的输出、后台任务通知：CLI 用标签包起来写进 transcript。
 * 手机上的 ! 命令也照这个格式写，缓冲里的事件用它转，与 transcript 读出来的一样
 */
export function fromUserText(text: string, uuid: string): SessionEvent | undefined {
  if (!text.trim() || text.startsWith('<local-command-caveat>') || text.startsWith('<system-reminder>')) return
  const cmd = tag(text, 'command-name')
  if (cmd !== undefined) {
    const args = tag(text, 'command-args')?.trim()
    return { type: 'user_input', text: args ? `${cmd} ${args}` : cmd, uuid }
  }
  const bash = tag(text, 'bash-input')
  if (bash !== undefined) return { type: 'user_input', text: `! ${bash}`, uuid }
  const out = [tag(text, 'local-command-stdout'), tag(text, 'bash-stdout'), tag(text, 'bash-stderr')]
  if (out.some((o) => o !== undefined)) {
    // 首行的缩进留着（git status -s 这类）
    const s = out.filter(Boolean).join('\n').replace(ANSI, '').replace(/^\s*\n/, '').trimEnd()
    return s ? { type: 'note', text: s, mono: true } : undefined
  }
  if (text.startsWith('<task-notification>')) {
    const summary = tag(text, 'summary')
    return summary ? { type: 'note', text: `后台任务：${summary.trim()}` } : undefined
  }
  return { type: 'user_input', text, uuid }
}
