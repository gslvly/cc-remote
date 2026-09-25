// 带鉴权调服务端接口：token 取自 ~/.cc-remote/config.json（和登录页输入的是同一个），不用手动带
//   bun scripts/api.ts <路径> [-q k=v]… [-d JSON|@文件] [--port 8687] [--full] [--write]
//   bun scripts/api.ts /sessions/<id>/events [--wait 秒]   听内容流，一条一行
//   bun scripts/api.ts --list [关键字]                      列出接口
// 带 -d 就是 POST。平时在用的端口（默认 8686）只放 GET，要写得加 --write
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { parseArgs } from 'node:util'
import { loadConfig, resolveHost } from '../server/config'
import { streamLine } from '../server/debug'

const MAX = 4000
const { config } = loadConfig()
const { values: o, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    query: { type: 'string', short: 'q', multiple: true, default: [] },
    data: { type: 'string', short: 'd' },
    port: { type: 'string', default: String(config.port) },
    wait: { type: 'string', default: '3' },
    full: { type: 'boolean', default: false },
    write: { type: 'boolean', default: false },
    list: { type: 'boolean', default: false },
  },
})
const arg = positionals[0]

function die(msg: string, code = 1): never {
  console.error(`✗ ${msg}`)
  process.exit(code)
}

if (o.list) {
  const src = readFileSync(join(import.meta.dir, '../server/index.ts'), 'utf8')
  for (const [, method, route] of src.matchAll(/^api\.(get|post|put|delete|patch)\('([^']+)'/gm))
    if (!arg || route!.includes(arg)) console.log(`${method!.toUpperCase().padEnd(5)}/api${route}`)
  process.exit(0)
}
if (!arg?.startsWith('/')) die('用法：bun scripts/api.ts <路径，如 /sessions> [-q k=v] [-d JSON|@文件] [--port 8687] [--full] [--write] | --list [关键字]')

let body: string | undefined
if (o.data !== undefined) {
  body = o.data.startsWith('@') ? readFileSync(o.data.slice(1), 'utf8') : o.data
  try {
    JSON.parse(body)
  } catch {
    die('-d 不是合法 JSON')
  }
  if (o.port === String(config.port) && !o.write) die(`${o.port} 是平时在用的服务端，POST 会动到真实会话；确定要发加 --write`)
}

const params = new URLSearchParams()
for (const kv of o.query) {
  const i = kv.indexOf('=')
  if (i < 0) die(`-q 要写成 k=v：${kv}`)
  params.append(kv.slice(0, i), kv.slice(i + 1))
}
const url = (host: string) => `http://${host}:${o.port}/api${arg}${params.size ? (arg.includes('?') ? '&' : '?') + params : ''}`
const headers: Record<string, string> = { Authorization: `Bearer ${config.token}` }
if (body !== undefined) headers['Content-Type'] = 'application/json'

/** dev 和 e2e 的服务端听 127.0.0.1，bun start 听 config 里的 host（默认 tailscale 地址）：先试前者 */
async function request(init: RequestInit): Promise<Response> {
  try {
    return await fetch(url('127.0.0.1'), init)
  } catch {
    const host = resolveHost(config.host)
    if (host && host !== '127.0.0.1') return fetch(url(host), init).catch(() => die(`连不上 ${host}:${o.port}，服务端起着吗？`))
    return die(`连不上 127.0.0.1:${o.port}，服务端起着吗？`)
  }
}

if (/\/events$/.test(arg) && body === undefined) {
  const r = await request({ headers, signal: AbortSignal.timeout(Number(o.wait) * 1000) })
  if (!r.ok) die(`${r.status} ${await r.text()}`, 2)
  let buf = ''
  try {
    for await (const chunk of r.body!.pipeThrough(new TextDecoderStream())) {
      buf += chunk
      for (let i; (i = buf.indexOf('\n\n')) >= 0; buf = buf.slice(i + 2)) {
        const block = buf.slice(0, i)
        const event = block.match(/^event: ?(.*)$/m)?.[1]
        const data = block.match(/^data: ?(.*)$/m)?.[1]
        if (event && data) console.log(streamLine(event, JSON.parse(data)))
      }
    }
  } catch {
    // --wait 到点断开
  }
  process.exit(0)
}

const r = await request({ method: body === undefined ? 'GET' : 'POST', headers, body })
let out = await r.text()
try {
  out = JSON.stringify(JSON.parse(out))
} catch {}
if (!o.full && out.length > MAX) out = `${out.slice(0, MAX)}…（共 ${out.length} 字符，--full 看全部）`
if (!r.ok) die(`${r.status} ${out}`, 2)
console.log(out || `✓ ${r.status}`)
