// 端到端测试脚手架：起测试服务端、登录、建测试目录、模拟终端、测完清理。每批的脚本只写自己的步骤：
//
//   import { run, api, until, check, testDir, terminal, events, text } from './harness'
//   await run(async ({ page }) => { … }, { browser: true })
//
// 跑：bun scripts/e2e/<名字>.ts（Claude 按量计费，服务端和「终端」都用 haiku）
import { mkdirSync, readdirSync, realpathSync, rmSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { chromium, type Browser, type Page } from 'playwright-core'
import { CLAUDE_DIR, loadConfig } from '../../server/config'
import { streamLine } from '../../server/debug'
import { PARENT_SESSION_ENV } from '../../server/child'

const REPO = join(import.meta.dir, '../..')
/** 8686 留给平时用的那个服务端 */
export const PORT = 8687
export const BASE = `http://127.0.0.1:${PORT}`
/** 测试目录都建在这下面：要在 roots 内（默认 ~），/tmp 不在 */
const ROOT = join(homedir(), 'ccr-e2e')
/** 服务端日志、截图 */
export const OUT = join(import.meta.dir, 'out')
const token = loadConfig().config.token

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** 子进程的环境：去掉从 Claude Code 终端继承的父会话标记，模型用 haiku */
function env(extra: Record<string, string> = {}) {
  const e: Record<string, string | undefined> = { ...process.env, ANTHROPIC_MODEL: 'haiku', ...extra }
  for (const k of PARENT_SESSION_ENV) delete e[k]
  return e
}

/** 调服务端接口：有 body 就 POST JSON。非 2xx 抛错，错误上带 status */
export async function api<T = any>(path: string, body?: unknown): Promise<T> {
  const r = await fetch(`${BASE}/api${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { Authorization: `Bearer ${token}`, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const text = await r.text()
  if (!r.ok) throw Object.assign(new Error(`${r.status} ${path}：${text}`), { status: r.status })
  return text ? JSON.parse(text) : (undefined as T)
}

/** 轮询到 fn 返回真值（page.waitForFunction 传 async 函数不会真等，服务端状态要这样等） */
export async function until<T>(label: string, fn: () => T | Promise<T>, ms = 90_000): Promise<NonNullable<T>> {
  const t0 = Date.now()
  for (;;) {
    const v = await fn()
    if (v) return v
    if (Date.now() - t0 > ms) throw new Error(`超时：${label}`)
    await sleep(500)
  }
}

let failed = 0
export function check(ok: unknown, label: string, detail?: unknown) {
  if (!ok) failed++
  console.log(`${ok ? '✓' : '✗'} ${label}${detail === undefined ? '' : `：${typeof detail === 'string' ? detail : JSON.stringify(detail)}`}`)
}

/** 新建一个测试目录，返回真实路径（服务端比对 cwd 用的是真实路径） */
export function testDir(name: string): string {
  const d = join(ROOT, name)
  mkdirSync(d, { recursive: true })
  return realpathSync(d)
}

const terminals: Bun.Subprocess[] = []

/** 「终端」：不经服务端直接跑 claude -p，服务端从登记表和 transcript 看到它。--allowedTools 要写成 --allowedTools=Bash */
export function terminal(cwd: string, prompt: string, ...args: string[]) {
  const proc = Bun.spawn(['claude', '-p', prompt, ...args], { cwd, env: env(), stdout: 'pipe', stderr: 'inherit' })
  terminals.push(proc)
  const output = new Response(proc.stdout).text()
  return { proc, output, exited: proc.exited, get running() { return proc.exitCode === null } }
}

let page: Page | undefined
/** 截图存到 out/，出问题再看；平时用 text() 核对，省得读图 */
export const shot = (name: string) => page?.screenshot({ path: join(OUT, `${name}.png`) })

/** 页面上看得见的文字，空行压掉 */
export const text = async (selector = 'body') => (await page!.locator(selector).innerText()).replace(/\n\s*\n/g, '\n').trim()

const streams: AbortController[] = []

/** 订阅会话的内容流（SSE），收到的攒在 msgs 里：审批请求、状态变化、重建都在这。lines() 一条一行 */
export function events(id: string) {
  const msgs: { event: string; data: any }[] = []
  const ac = new AbortController()
  streams.push(ac)
  void (async () => {
    const r = await fetch(`${BASE}/api/sessions/${id}/events`, { headers: { Authorization: `Bearer ${token}` }, signal: ac.signal })
    let buf = ''
    for await (const chunk of r.body!.pipeThrough(new TextDecoderStream())) {
      buf += chunk
      for (let i; (i = buf.indexOf('\n\n')) >= 0; buf = buf.slice(i + 2)) {
        const block = buf.slice(0, i)
        const event = block.match(/^event: ?(.*)$/m)?.[1]
        const data = block.match(/^data: ?(.*)$/m)?.[1]
        if (event && data) msgs.push({ event, data: JSON.parse(data) })
      }
    }
  })().catch(() => {})
  const lines = () => msgs.map(({ event, data }) => streamLine(event, data))
  return { msgs, lines, close: () => ac.abort() }
}

/** 删掉测试目录和它们的 transcript（~/.claude/projects 下按 cwd 命名，非字母数字都换成 -） */
function cleanup() {
  rmSync(ROOT, { recursive: true, force: true })
  const prefix = ROOT.replace(/[^a-zA-Z0-9]/g, '-')
  const projects = join(CLAUDE_DIR, 'projects')
  for (const d of readdirSync(projects)) if (d.startsWith(prefix)) rmSync(join(projects, d), { recursive: true, force: true })
}

async function startServer(extra: Record<string, string> = {}) {
  Bun.spawnSync(['sh', '-c', `lsof -ti tcp:${PORT} | xargs kill 2>/dev/null`])
  const log = join(OUT, 'server.log')
  const proc = Bun.spawn(['bun', 'server/index.ts'], {
    cwd: REPO,
    env: env({ ...extra, CCR_HOST: '127.0.0.1', CCR_PORT: String(PORT) }),
    stdout: Bun.file(log),
    stderr: Bun.file(log),
  })
  await until('服务端起来', () => fetch(`${BASE}/api/build`).then((r) => r.ok, () => false), 15_000)
  return proc
}

/**
 * 跑一批测试：清掉上次中断留下的 → 起服务端（browser 时先 build，再开手机尺寸的页面并登录）→ main → 清理。
 * main 抛错或有 check 没过，退出码为 1。env：服务端额外的环境变量（比如 CCR_PUSH）
 */
export async function run(main: (ctx: { page: Page }) => Promise<void>, opts: { browser?: boolean; env?: Record<string, string> } = {}) {
  mkdirSync(OUT, { recursive: true })
  cleanup()
  if (opts.browser && Bun.spawnSync(['bun', 'run', 'build'], { cwd: REPO, stdout: 'ignore' }).exitCode) throw new Error('build 失败')
  const server = await startServer(opts.env)
  let browser: Browser | undefined
  let finishing: Promise<void> | undefined
  const finish = () =>
    (finishing ??= (async () => {
      for (const t of terminals) t.kill()
      for (const s of streams) s.abort()
      await browser?.close().catch(() => {})
      // claude 进程退出时还会往 transcript 里补几行；服务端不等它的子进程，这里等全部退出再清理
      const children = Bun.spawnSync(['pgrep', '-P', String(server.pid)]).stdout.toString().split('\n').filter(Boolean).map(Number)
      server.kill()
      await Promise.all([server.exited, ...terminals.map((t) => t.exited)])
      const gone = (pid: number) => {
        try {
          process.kill(pid, 0)
          return false
        } catch {
          return true
        }
      }
      await until('claude 子进程退出', () => children.every(gone), 10_000).catch((e) => console.error(e.message))
      cleanup()
    })())
  for (const sig of ['SIGINT', 'SIGTERM'] as const) process.on(sig, () => void finish().then(() => process.exit(130)))

  try {
    if (opts.browser) {
      browser = await chromium.launch()
      const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true })
      page = await ctx.newPage()
      page.on('console', (m) => ['warning', 'error'].includes(m.type()) && console.log(`  [console] ${m.text()}`))
      // 在页面里登录（ctx.request 在 bun 下解析 set-cookie 会崩）
      await page.goto(`${BASE}/api/build`)
      await page.evaluate((token) => fetch('/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token }) }), token)
      await page.goto(BASE + '/')
    }
    await main({ page: page! })
  } catch (e) {
    failed++
    console.error('✗ 中断：', e instanceof Error ? e.message : e)
    await shot('fail')
  } finally {
    await finish()
  }
  console.log(failed ? `\n${failed} 项失败（日志、截图在 ${OUT}）` : '\n全部通过')
  process.exit(failed ? 1 : 0)
}
