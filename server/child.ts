// 起 claude 子进程要用的：环境变量、流式输入
import type { SDKUserMessage } from '@anthropic-ai/claude-agent-sdk'

/**
 * 从某个 Claude Code 终端里启动服务端时会继承这些「父会话」标记，
 * 子进程会误以为自己是那个终端的子会话，所以去掉。
 * 入口标记也去掉，交给 SDK 设为 sdk-ts：设成 cli 也会被 CLI 在无头模式下改写成 sdk-cli（见 REFERENCE.md）。
 */
export const PARENT_SESSION_ENV = [
  'CLAUDE_CODE_ENTRYPOINT',
  'CLAUDECODE',
  'CLAUDE_CODE_SESSION_ID',
  'CLAUDE_CODE_CHILD_SESSION',
  'CLAUDE_CODE_SESSION_ATTENDED',
  'CLAUDE_CODE_MESSAGING_SOCKET',
  'CLAUDE_CODE_MESSAGING_TOKEN',
  'CLAUDE_CODE_EXECPATH',
  'CLAUDE_CODE_SSE_PORT',
  'CLAUDE_PID',
  'CLAUDE_EFFORT',
]

export function childEnv(): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = { ...process.env }
  for (const k of PARENT_SESSION_ENV) delete env[k]
  env.CLAUDE_AGENT_SDK_CLIENT_APP = 'cc-remote/0.1.0'
  return env
}

/** 流式输入：进程常驻，push 一条就是一轮输入 */
export class InputQueue implements AsyncIterable<SDKUserMessage> {
  private items: SDKUserMessage[] = []
  private wake?: () => void
  private closed = false

  push(msg: SDKUserMessage) {
    this.items.push(msg)
    this.wake?.()
  }

  close() {
    this.closed = true
    this.wake?.()
  }

  async *[Symbol.asyncIterator]() {
    while (true) {
      const next = this.items.shift()
      if (next) yield next
      else if (this.closed) return
      else await new Promise<void>((r) => (this.wake = r))
    }
  }
}
