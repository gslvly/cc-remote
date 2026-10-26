// 会话的最后活动时间：transcript 里最后一条带时间的记录。
// 不用 SDK 的 lastModified（文件修改时间）：终端里开着的 Claude Code 每小时把当前会话的 transcript touch 一下
// （防着别的进程按修改时间清理过期会话时删掉它），闲着的会话每小时就跳到列表前面一次。
// 终端在等批准时是哪次工具调用（推送里要写）也从末尾读。会话标题缺第一句时从开头读（transcript.ts 的 titleOf）
import type { SDKSessionInfo } from '@anthropic-ai/claude-agent-sdk'
import { type FileHandle, open, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { CLAUDE_DIR } from './config'

const PROJECTS = join(CLAUDE_DIR, 'projects')
/** 从末尾往前读的窗口，一次不够再放大：最后一条带时间的可能很长（贴图、长输出） */
const WINDOWS = [64 << 10, 1 << 20, 8 << 20]

/** 按会话 id 记下文件多大时算出的时间。touch 不改大小，大小没变就不用再读 */
const cache = new Map<string, { size: number; at: number }>()

export async function lastActivity(s: SDKSessionInfo): Promise<number> {
  const hit = cache.get(s.sessionId)
  if (hit && hit.size === s.fileSize) return hit.at
  const at = await lastTimestamp(s)
  // 修改时间是上限：写进去时一定更新过它
  const v = at ? Math.min(at, s.lastModified) : s.lastModified
  if (s.fileSize !== undefined) cache.set(s.sessionId, { size: s.fileSize, at: v })
  return v
}

/** lastModified 换成最后活动时间，按它倒序 */
export async function byActivity(list: SDKSessionInfo[]): Promise<SDKSessionInfo[]> {
  const out = await Promise.all(list.map(async (s) => ({ ...s, lastModified: await lastActivity(s) })))
  return out.sort((a, b) => b.lastModified - a.lastModified)
}

async function lastTimestamp(s: SDKSessionInfo): Promise<number | undefined> {
  const f = await openTranscript(s)
  if (!f) return
  try {
    const { size } = await f.stat()
    for (const w of WINDOWS) {
      const lines = await tail(f, size, w)
      for (let i = lines.length - 1; i >= 0; i--) {
        const at = timeOf(lines[i]!)
        if (at) return at
      }
      if (w >= size) return
    }
  } finally {
    await f.close()
  }
}

export interface PendingTool {
  name: string
  input: Record<string, unknown>
}

/**
 * 终端在等批准的那次工具调用：末尾一段里最早一个还没有结果的（并行调用时终端按顺序问）。
 * 子代理里的调用在它自己的 transcript 里，主链上只看得到 Agent 本身，这种不算
 */
export async function pendingTool(sessionId: string, cwd: string): Promise<PendingTool | undefined> {
  const f = await openTranscript({ sessionId, cwd })
  if (!f) return
  try {
    const unresolved = new Map<string, PendingTool>()
    for (const line of await tail(f, (await f.stat()).size, WINDOWS[0]!)) {
      if (!line.includes('"tool_')) continue
      try {
        const content = (JSON.parse(line) as { message?: { content?: unknown } }).message?.content
        for (const b of Array.isArray(content) ? content : []) {
          if (b?.type === 'tool_use') unresolved.set(b.id, { name: b.name, input: b.input ?? {} })
          else if (b?.type === 'tool_result') unresolved.delete(b.tool_use_id)
        }
      } catch {}
    }
    const t = unresolved.values().next().value
    return t && !['Agent', 'Task'].includes(t.name) ? t : undefined
  } finally {
    await f.close()
  }
}

/** 末尾 w 字节的各行。窗口开头那行多半不完整，不要 */
async function tail(f: FileHandle, size: number, w: number) {
  const start = Math.max(0, size - w)
  const buf = Buffer.alloc(size - start)
  await f.read(buf, 0, buf.length, start)
  const lines = buf.toString('utf8').split('\n')
  if (start > 0) lines.shift()
  return lines
}

/** 先按 cwd 找项目目录；会话中途 cd 过、路径太长被截断加哈希的，挨个项目目录找 */
export async function openTranscript(s: Pick<SDKSessionInfo, 'sessionId' | 'cwd'>) {
  const name = `${s.sessionId}.jsonl`
  const tryOpen = (dir: string) => open(join(PROJECTS, dir, name)).catch(() => undefined)
  const guess = s.cwd?.replace(/[^a-zA-Z0-9]/g, '-')
  const f = guess && (await tryOpen(guess))
  if (f) return f
  for (const d of await readdir(PROJECTS).catch(() => [])) {
    if (d === guess) continue
    const f = await tryOpen(d)
    if (f) return f
  }
}

/** 顶层的 timestamp；cost-state、ai-title 这类元数据行没有 */
function timeOf(line: string): number | undefined {
  if (!line.includes('"timestamp"')) return
  try {
    const t = (JSON.parse(line) as { timestamp?: unknown }).timestamp
    return typeof t === 'string' ? Date.parse(t) || undefined : undefined
  } catch {
    return
  }
}
