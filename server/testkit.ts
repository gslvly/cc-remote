// 单测夹具。测试文件最先 import 它，再动态 import 被测模块（CLAUDE_CONFIG_DIR 要在 config.ts 载入前设好）：
//
//   import { Transcript, lines } from './testkit'
//   const { Session } = await import('./session')
//
// transcript 写在临时的 CLAUDE_CONFIG_DIR 里，由 SDK 真去读；query 换成假的：
// 把收到的消息和回复按同样的 uuid 写进 transcript，和真 CLI 一样
import { mock } from 'bun:test'
import * as sdk from '@anthropic-ai/claude-agent-sdk'
import { appendFileSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { eventLine } from './debug'
import type { Session } from './session'

const root = mkdtempSync(join(tmpdir(), 'ccr-test-'))
process.env.CLAUDE_CONFIG_DIR = root
process.on('exit', () => rmSync(root, { recursive: true, force: true }))

export const CWD = '/tmp/ccr-fixture'
const PROJECT = join(root, 'projects', CWD.replace(/[^a-zA-Z0-9]/g, '-'))
mkdirSync(PROJECT, { recursive: true })

const transcripts = new Map<string, Transcript>()

/** 一个会话的 transcript。假 query 按 id 找到它往里写 */
export class Transcript {
  last?: string
  private t = Date.parse('2026-09-25T00:00:00Z')
  constructor(readonly id: string = crypto.randomUUID()) {
    transcripts.set(id, this)
  }

  /** 默认接在上一条后面；parent 指定更早的一条就是回退后另起一支 */
  add(type: 'user' | 'assistant', content: unknown, o: { parent?: string; uuid?: string; extra?: object } = {}) {
    const uuid = o.uuid ?? crypto.randomUUID()
    const message =
      type === 'user'
        ? { role: 'user', content }
        : { id: `msg_${uuid.slice(0, 8)}`, type: 'message', role: 'assistant', model: 'claude-haiku-4-5', content, stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 } }
    const line = { type, uuid, parentUuid: ('parent' in o ? o.parent : this.last) ?? null, isSidechain: false, userType: 'external', sessionId: this.id, cwd: CWD, timestamp: new Date((this.t += 1000)).toISOString(), message, ...o.extra }
    appendFileSync(join(PROJECT, `${this.id}.jsonl`), JSON.stringify(line) + '\n')
    this.last = uuid
    return uuid
  }
  user(text: string, o?: { parent?: string; uuid?: string }) {
    return this.add('user', text, o)
  }
  reply(text: string) {
    return this.add('assistant', [{ type: 'text', text }])
  }
}

/** 每起一个假子进程记一条：启动参数（canUseTool 从这里拿来直接调），setPermissionMode 收到的 */
export const spawned: { id: string; options: sdk.Options; modes: sdk.PermissionMode[] }[] = []

/** 假子进程：每收到一条，写进 transcript（用消息自带的 uuid），回一句 re: … */
function fakeQuery({ prompt, options }: { prompt: AsyncIterable<sdk.SDKUserMessage>; options: sdk.Options }) {
  const id = (options.sessionId ?? options.resume)!
  const rec = { id, options, modes: [] as sdk.PermissionMode[] }
  spawned.push(rec)
  const t = transcripts.get(id) ?? new Transcript(id)
  async function* gen() {
    for await (const m of prompt) {
      t.user(m.message.content as string, { uuid: m.uuid })
      yield { type: 'system', subtype: 'init', model: 'haiku', permissionMode: 'default', session_id: id, uuid: crypto.randomUUID() }
      const text = `re: ${m.message.content}`
      const uuid = t.reply(text)
      yield { type: 'assistant', uuid, session_id: id, parent_tool_use_id: null, message: { role: 'assistant', content: [{ type: 'text', text }] } }
      yield { type: 'result', subtype: 'success', is_error: false, result: text, session_id: id, uuid: crypto.randomUUID(), modelUsage: { haiku: { contextWindow: 200_000 } } }
    }
  }
  return Object.assign(gen(), {
    interrupt: async () => {},
    close: () => {},
    setPermissionMode: async (m: sdk.PermissionMode) => void rec.modes.push(m),
    getContextUsage: async () => ({ rawMaxTokens: 200_000, model: 'haiku' }),
    getSettings: async () => ({ applied: { effort: null } }),
  })
}
mock.module('@anthropic-ai/claude-agent-sdk', () => ({ ...sdk, query: fakeQuery }))

/** 会话缓冲里的内容，一条一行 */
export const lines = (s: Session) => s.history(s.lastSeq + 1).events.map(({ ev }) => eventLine(ev))

/** 看着的手机收到的消息类型 */
export function watch(s: Session) {
  const got: string[] = []
  s.subscribe((m) => got.push(m.event))
  return got
}

export async function idle(s: Session) {
  while (s.state !== 'idle') await Bun.sleep(5)
}
