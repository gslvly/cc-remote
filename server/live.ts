import type { SDKPartialAssistantMessage } from '@anthropic-ai/claude-agent-sdk'
import type { LiveBlock, LiveUpdate } from '../shared/protocol'

type StreamEvent = SDKPartialAssistantMessage['event']

/** 攒多久推一次 */
const FLUSH_MS = 80
/** 工具参数只留开头这么多，够取文件名、命令之类的摘要 */
const HEAD = 1000

/**
 * 蹦字：把主链的增量合并进「正在生成的那一块」，攒一批再推。增量不进重放缓冲。
 * 实测（2.1.282）：完整的 assistant 消息（每条只含一块）紧跟在这一块最后一个增量之后、content_block_stop 之前；
 * 中断时会补发一条半截的完整消息，但没有 stop 事件。所以快照靠完整消息作废，不靠 stop
 */
export class LiveTracker {
  /** hello 里发给新连上的手机 */
  block: LiveBlock | null = null
  private msgId = ''
  /** 手机端已经知道的：哪一块、文本多长 */
  private sent: { id: string; len: number } | null = null
  private timer?: ReturnType<typeof setTimeout>

  constructor(private emit: (u: LiveUpdate) => void) {}

  onStream(e: StreamEvent) {
    switch (e.type) {
      case 'message_start':
        this.msgId = e.message.id
        return
      case 'content_block_start': {
        const id = `${this.msgId}:${e.index}`
        const b = e.content_block
        if (b.type === 'text') this.block = { kind: 'text', id, text: b.text }
        else if (b.type === 'thinking' || b.type === 'redacted_thinking') this.block = { kind: 'thinking', id, tokens: 0 }
        else if ('name' in b && typeof b.name === 'string') this.block = { kind: 'tool', id, name: b.name, head: '' }
        else this.block = null // 服务端工具的结果之类，不在这里显示
        break
      }
      case 'content_block_delta': {
        const b = this.block
        if (!b || b.id !== `${this.msgId}:${e.index}`) return
        const d = e.delta
        if (d.type === 'text_delta' && b.kind === 'text') b.text += d.text
        else if (d.type === 'input_json_delta' && b.kind === 'tool' && b.head.length < HEAD)
          b.head = (b.head + d.partial_json).slice(0, HEAD)
        else return
        break
      }
      case 'message_stop':
        // 正常情况下完整消息已经把快照清掉了，这里兜底
        this.clear()
        return
      default:
        return
    }
    this.schedule()
  }

  /** system/thinking_tokens */
  onThinkingTokens(tokens: number) {
    if (this.block?.kind !== 'thinking') return
    this.block.tokens = tokens
    this.schedule()
  }

  /** 主链的完整 assistant 消息、result 进了缓冲：手机端收到那条事件会自己清掉快照，这里不用再通知 */
  settle() {
    this.block = null
    this.sent = null
  }

  /**
   * 没有对应的事件可以替换快照（进程退出等），要通知手机端清掉。立即发：
   * 这一块可能还没推过（sent 为空），但新连上的手机已经从 hello 里拿到了
   */
  clear() {
    if (!this.block && !this.sent) return
    this.block = null
    this.sent = null
    this.emit({ op: 'set', block: null })
  }

  private schedule() {
    this.timer ??= setTimeout(() => this.flush(), FLUSH_MS)
  }

  private flush() {
    this.timer = undefined
    const b = this.block
    if (!b) {
      if (this.sent) this.emit({ op: 'set', block: null })
      this.sent = null
      return
    }
    if (b.kind === 'text' && this.sent?.id === b.id) {
      const at = this.sent.len
      if (b.text.length > at) this.emit({ op: 'append', id: b.id, at, text: b.text.slice(at) })
      this.sent.len = b.text.length
      return
    }
    this.emit({ op: 'set', block: { ...b } })
    this.sent = { id: b.id, len: b.kind === 'text' ? b.text.length : 0 }
  }
}
