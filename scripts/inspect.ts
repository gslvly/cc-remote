// 看一个会话：transcript 按服务端的转换一条一行，加上终端登记表里的状态；--port 再列出那个服务端缓冲里的
//   bun scripts/inspect.ts <id 或前缀> [--port 8687] [--all]
import { readdirSync } from 'node:fs'
import { join } from 'node:path'
import { getSessionInfo } from '@anthropic-ai/claude-agent-sdk'
import type { HistoryPage, SessionInfo } from '../shared/protocol'
import { CLAUDE_DIR, loadConfig } from '../server/config'
import { eventLine } from '../server/debug'
import { scanHolders } from '../server/terminal'
import { readTranscript } from '../server/transcript'

const [prefix, ...rest] = process.argv.slice(2)
const port = rest.includes('--port') ? rest[rest.indexOf('--port') + 1] : undefined
const all = rest.includes('--all')
if (!prefix) {
  console.error('用法：bun scripts/inspect.ts <id 或前缀> [--port 8687] [--all]')
  process.exit(1)
}

const projects = join(CLAUDE_DIR, 'projects')
const ids = new Set<string>()
for (const d of readdirSync(projects)) {
  try {
    for (const f of readdirSync(join(projects, d))) if (f.startsWith(prefix) && f.endsWith('.jsonl')) ids.add(f.slice(0, -6))
  } catch {}
}
if (ids.size !== 1) {
  console.error(ids.size ? `前缀对上多个：${[...ids].join(' ')}` : '没找到')
  process.exit(1)
}
const [id] = ids as unknown as [string]

const tail = <T>(xs: T[]) => (all ? xs : xs.slice(-40))
const more = (n: number, shown: number) => (shown < n ? `，只列最后 ${shown} 条，--all 看全部` : '')

const meta = await getSessionInfo(id)
const holder = (await scanHolders()).get(id)
console.log(`${id}  ${meta?.cwd}`)
console.log(`标题：${meta?.summary}  修改：${meta && new Date(meta.lastModified).toLocaleString()}  ${meta?.fileSize} 字节`)
console.log(`终端：${holder ? `pid ${holder.pid} ${holder.status}` : '无'}`)

const entries = await readTranscript(id)
const shown = tail(entries)
console.log(`\ntranscript 主链 ${entries.length} 条（· 是不显示的）${more(entries.length, shown.length)}`)
for (const e of shown) console.log(`${e.uuid.slice(0, 8)}  ${e.ev ? eventLine(e.ev) : '·'}`)

if (port) {
  const get = async <T>(p: string): Promise<T> => {
    const r = await fetch(`http://127.0.0.1:${port}/api/sessions/${id}${p}`, { headers: { Authorization: `Bearer ${loadConfig().config.token}` } })
    if (!r.ok) throw new Error(`${r.status} ${await r.text()}`)
    return r.json() as Promise<T>
  }
  const info = await get<SessionInfo>('')
  const page = await get<HistoryPage>('/history?before=1000000000')
  const evs = tail(page.events)
  console.log(`\n服务端 ${port}：epoch ${page.epoch}  ${info.state}${info.live ? ' 有子进程' : ''}${info.terminal ? ` 终端 ${info.terminal}` : ''}${more(page.events.length, evs.length)}`)
  for (const e of evs) console.log(`${String(e.seq).padStart(4)}  ${eventLine(e.ev)}`)
}
