import { listSessions } from '@anthropic-ai/claude-agent-sdk'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { join, normalize } from 'node:path'
import { type Context, Hono } from 'hono'
import { type SSEMessage, streamSSE } from 'hono/streaming'
import type {
  CreateSessionBody,
  DirEntry,
  DirInfo,
  DirSessions,
  FavoriteBody,
  FsList,
  PermissionDecisionBody,
  RecentDir,
  SendMessageBody,
  SetModeBody,
  StreamHello,
  SwitchableMode,
} from '../shared/protocol'
import { createAuth } from './auth'
import { Awake } from './awake'
import { CONFIG_FILE, loadConfig, resolveRoots, waitForHost } from './config'
import { Favorites } from './favorites'
import { checkDir, dirEntry, gitBranch, listDirs } from './fs'
import { LimitError, SessionManager } from './manager'
import { pusher } from './push'
import { ConflictError, type EventId } from './session'
import { isEmpty, titleOf } from './transcript'
import { quota } from './usage'

// 输出到文件时（launchd、e2e）每行带上时间
if (!process.stdout.isTTY) {
  for (const k of ['log', 'warn', 'error'] as const) {
    const write = console[k]
    console[k] = (...args: unknown[]) => write(new Date().toLocaleString('sv-SE'), ...args)
  }
}

const { config, created } = loadConfig()
const auth = createAuth(config.token)
const roots = resolveRoots(config.roots)
const sessions = new SessionManager({ maxLive: config.maxLive, idleMinutes: config.idleMinutes, roots })
const favorites = new Favorites()
// 托管会话在跑、等审批时不让 Mac 空闲睡眠
const awake = new Awake()
sessions.watch((list) => awake.set(list.some((s) => s.live && s.state !== 'idle')))
const DIST = join(import.meta.dir, '../web/dist')

const isDir = (p: string) => {
  try {
    return statSync(p).isDirectory()
  } catch {
    return false
  }
}

// dist 当前的构建号（vite build 写入）。每次现读，重新 build 后不用重启服务端
const buildId = () => {
  try {
    return readFileSync(join(DIST, 'build.txt'), 'utf8').trim()
  } catch {
    return ''
  }
}

/**
 * SSE 长连接。setup 里同步地发首条消息并订阅（中间不会漏事件），返回取消订阅。
 * writeSSE 写之前有 await，连着调用不保证顺序，所以这里把写入串起来；另有 20 秒一次的 ping
 */
function sse(c: Context, setup: (send: (m: SSEMessage) => void) => () => void) {
  return streamSSE(c, async (stream) => {
    let chain = Promise.resolve()
    const enqueue = (write: () => Promise<unknown>) => {
      chain = chain.then(write).then(
        () => {},
        () => {},
      )
    }
    const cleanup = setup((m) => enqueue(() => stream.writeSSE(m)))
    const ping = setInterval(() => enqueue(() => stream.write(': ping\n\n')), 20_000)
    await new Promise<void>((resolve) => stream.onAbort(resolve))
    clearInterval(ping)
    cleanup()
  })
}

const parseEventId = (s: string | undefined): EventId | undefined => {
  const m = s?.match(/^(\w+):(\d+)$/)
  return m ? { epoch: m[1]!, seq: Number(m[2]) } : undefined
}

const commandError = (c: Context, e: unknown) => {
  if (e instanceof LimitError) return c.json({ error: e.message }, 429)
  if (e instanceof ConflictError) return c.json({ error: e.message }, 409)
  throw e
}

const NOT_FOUND = { error: '会话不存在' }

const MODES = new Set<unknown>(['default', 'acceptEdits', 'plan'] satisfies SwitchableMode[])

const api = new Hono()

// 每个 API 响应（包括 401）都带构建号，前端比对后决定要不要刷新
api.use('*', async (c, next) => {
  await next()
  c.header('Cache-Control', 'no-store')
  const build = buildId()
  if (build) c.header('x-ccr-build', build)
})

// 前端回到前台、SW 换代时用它取构建号（在响应头里），不需要登录
api.get('/build', (c) => c.json({ build: buildId() }))
api.post('/login', auth.login)
api.use('*', auth.require)
api.post('/logout', auth.logout)

// 最近目录：不自己记，按 listSessions 的 cwd 聚合（终端里用过的目录也在）；不在 roots 内的不列
api.get('/recent', async (c) => {
  const all = await listSessions({ limit: 500 })
  const byCwd = new Map<string, RecentDir>()
  for (const s of all) {
    if (!s.cwd || isEmpty(s)) continue
    const d = byCwd.get(s.cwd)
    if (!d) byCwd.set(s.cwd, { cwd: s.cwd, lastModified: s.lastModified, sessions: 1, lastTitle: titleOf(s) })
    else {
      d.sessions++
      if (s.lastModified > d.lastModified) Object.assign(d, { lastModified: s.lastModified, lastTitle: titleOf(s) })
    }
  }
  const usable = await Promise.all([...byCwd.values()].map(async (d) => ((await checkDir(d.cwd, roots)).ok ? d : undefined)))
  const dirs = usable
    .filter((d) => d !== undefined)
    .sort((a, b) => b.lastModified - a.lastModified)
    .slice(0, 30)
  return c.json(dirs)
})

// 选目录：只列子目录，限定在 roots 内。不给 path 时：只有一个 root 就列它，有多个就列出各个 root
api.get('/fs/ls', async (c) => {
  const hidden = c.req.query('hidden') === '1'
  const path = c.req.query('path') || (roots.length === 1 ? roots[0] : undefined)
  if (!path) return c.json<FsList>({ roots, path: null, entries: await Promise.all(roots.map((r) => dirEntry(r, r))) })

  const dir = await checkDir(path, roots)
  if (!dir.ok) return c.json({ error: dir.error }, dir.status)
  let entries: DirEntry[]
  try {
    entries = await listDirs(dir.path, roots, hidden)
  } catch (e) {
    // macOS 隐私保护的目录（Library 下的一些）、没权限的目录
    return c.json({ error: `读不了这个目录：${(e as NodeJS.ErrnoException).code ?? e}` }, 403)
  }
  return c.json<FsList>({ roots, path: dir.path, branch: await gitBranch(dir.path), entries })
})

// 目录页：分支、是否收藏
api.get('/dir', async (c) => {
  const dir = await checkDir(c.req.query('path'), roots)
  if (!dir.ok) return c.json({ error: dir.error }, dir.status)
  return c.json<DirInfo>({ path: dir.path, branch: await gitBranch(dir.path), favorite: favorites.has(dir.path) })
})

// 目录页的历史会话（终端里开的也在）：只要这个目录本身的，不含 git worktree
const DIR_PAGE = 30
api.get('/dir/sessions', async (c) => {
  const dir = await checkDir(c.req.query('path'), roots)
  if (!dir.ok) return c.json({ error: dir.error }, dir.status)
  const offset = Math.max(0, Number(c.req.query('offset')) || 0)
  const list = await listSessions({ dir: dir.path, limit: DIR_PAGE + 1, offset, includeWorktrees: false })
  return c.json<DirSessions>({
    // 滤掉的空会话让前端按条数算的 offset 偏小，下一页会有重叠，前端按 id 去重
    sessions: list.slice(0, DIR_PAGE).filter((s) => !isEmpty(s)).map((s) => ({
      id: s.sessionId,
      title: titleOf(s),
      lastModified: s.lastModified,
      branch: s.gitBranch,
    })),
    more: list.length > DIR_PAGE,
  })
})

// 收藏：已删除或移出 roots 的目录不列，但留在文件里（外接盘可能只是暂时没挂上）
api.get('/favorites', async (c) => {
  const dirs = await Promise.all(
    favorites.list().map(async (p) => {
      const dir = await checkDir(p, roots)
      return dir.ok ? dirEntry(dir.path) : undefined
    }),
  )
  return c.json(dirs.filter((d) => d !== undefined))
})

api.post('/favorites', async (c) => {
  const body = await c.req.json<FavoriteBody>()
  if (!body.favorite) {
    favorites.set(String(body.path), false)
    return c.json({ favorite: false })
  }
  const dir = await checkDir(body.path, roots)
  if (!dir.ok) return c.json({ error: dir.error }, dir.status)
  favorites.set(dir.path, true)
  return c.json({ favorite: true })
})

api.get('/sessions', (c) => c.json(sessions.list()))

// 概览流：全部会话的状态，手机在前台时一直连着（驱动标签条、跨会话的待批准横幅），以及额度。有它连着就不推送
api.get('/overview', (c) =>
  sse(c, (send) => {
    const push = (list: unknown) => send({ event: 'sessions', data: JSON.stringify(list) })
    const pushQuota = (q: unknown) => send({ event: 'quota', data: JSON.stringify(q) })
    push(sessions.list())
    if (quota.current) pushQuota(quota.current)
    const offSessions = sessions.watch(push)
    const offQuota = quota.watch(pushQuota)
    const unview = pusher.view()
    return () => {
      offSessions()
      offQuota()
      unview()
    }
  }),
)
api.post('/sessions', async (c) => {
  const body = await c.req.json<CreateSessionBody>()
  const prompt = body.prompt?.trim()
  if (!prompt) return c.json({ error: 'prompt 不能为空' }, 400)
  if (body.permissionMode !== undefined && !MODES.has(body.permissionMode)) return c.json({ error: '权限模式不对' }, 400)
  const dir = await checkDir(body.cwd, roots)
  if (!dir.ok) return c.json({ error: dir.error }, dir.status)
  try {
    return c.json(sessions.create(dir.path, prompt, body.permissionMode).info())
  } catch (e) {
    return commandError(c, e)
  }
})

// 不在内存里的会话（历史会话、终端会话）按 id 从 transcript 载入
api.get('/sessions/:id', async (c) => {
  const s = await sessions.open(c.req.param('id'))
  return s ? c.json(s.info()) : c.json(NOT_FOUND, 404)
})

// 内容流：只连当前在看的会话。浏览器自动重连带 Last-Event-ID 头，手动重连（切回来、回到前台）带 ?after=
api.get('/sessions/:id/events', async (c) => {
  const s = await sessions.open(c.req.param('id'))
  if (!s) return c.json(NOT_FOUND, 404)
  const after = parseEventId(c.req.header('last-event-id') ?? c.req.query('after'))
  const hello = (h: StreamHello) => ({ event: 'hello', data: JSON.stringify(h), id: `${h.epoch}:${s.lastSeq}` })
  return sse(c, (send) => {
    send(hello(s.hello(after)))
    return s.subscribe((m) =>
      send(
        m.event === 'hello'
          ? hello(m.data)
          : { event: m.event, data: JSON.stringify(m.data), id: m.event === 'ev' ? `${s.epoch}:${m.data.seq}` : undefined },
      ),
    )
  })
})

// 上滑加载更早的事件
api.get('/sessions/:id/history', async (c) => {
  const s = await sessions.open(c.req.param('id'))
  if (!s) return c.json(NOT_FOUND, 404)
  return c.json(s.history(Number(c.req.query('before')) || 0))
})

// 历史会话发消息就 resume；终端会话不行（只读，或者要先接管）
api.post('/sessions/:id/messages', async (c) => {
  const s = await sessions.open(c.req.param('id'))
  if (!s) return c.json(NOT_FOUND, 404)
  const { text } = await c.req.json<SendMessageBody>()
  if (!text?.trim()) return c.json({ error: '消息不能为空' }, 400)
  try {
    await sessions.send(s, text)
  } catch (e) {
    return commandError(c, e)
  }
  return c.json({ ok: true })
})

// 接管终端退出后留下的会话
api.post('/sessions/:id/takeover', async (c) => {
  const s = await sessions.open(c.req.param('id'))
  if (!s) return c.json(NOT_FOUND, 404)
  try {
    await sessions.takeover(s)
  } catch (e) {
    return commandError(c, e)
  }
  return c.json(s.info())
})

api.post('/sessions/:id/permissions/:reqId', async (c) => {
  const s = sessions.get(c.req.param('id'))
  if (!s) return c.json(NOT_FOUND, 404)
  const body = await c.req.json<PermissionDecisionBody>()
  if (body.behavior !== 'allow' && body.behavior !== 'deny') return c.json({ error: 'behavior 不对' }, 400)
  if (body.behavior === 'allow' && body.mode !== undefined && !MODES.has(body.mode)) return c.json({ error: '权限模式不对' }, 400)
  const ok = s.decide(c.req.param('reqId'), body)
  return ok ? c.json({ ok: true }) : c.json({ error: '请求已处理或已失效' }, 409)
})

// 切权限模式（终端里的 Shift+Tab）；历史会话也能先切好，发消息时带上
api.post('/sessions/:id/mode', async (c) => {
  const s = await sessions.open(c.req.param('id'))
  if (!s) return c.json(NOT_FOUND, 404)
  const { mode } = await c.req.json<SetModeBody>()
  if (!MODES.has(mode)) return c.json({ error: '权限模式不对' }, 400)
  try {
    await s.setMode(mode)
  } catch (e) {
    if (e instanceof ConflictError) return commandError(c, e)
    return c.json({ error: e instanceof Error ? e.message : String(e) }, 500)
  }
  return c.json(s.info())
})

api.post('/sessions/:id/interrupt', async (c) => {
  const s = sessions.get(c.req.param('id'))
  if (!s) return c.json(NOT_FOUND, 404)
  try {
    await s.interrupt()
  } catch (e) {
    return c.json({ error: e instanceof Error ? e.message : String(e) }, 500)
  }
  return c.json({ ok: true })
})

// 关掉会话：停子进程、出标签条；不在内存里的本来就是关着的。终端里正跑着的归终端管
api.post('/sessions/:id/close', (c) => {
  const s = sessions.get(c.req.param('id'))
  if (s?.terminal === 'running') return c.json({ error: '终端里的会话要在终端里退出' }, 409)
  s?.dismiss()
  return c.json({ ok: true })
})

const app = new Hono()
app.route('/api', api)

// 静态文件：index.html、sw.js、manifest、图标都 no-cache（每次向服务端确认）；/assets/* 文件名带 hash，永久缓存
app.get('*', async (c) => {
  const path = normalize(decodeURIComponent(new URL(c.req.url).pathname))
  const file = join(DIST, path)
  if (file.startsWith(DIST + '/') && !path.endsWith('/') && existsSync(file) && !isDir(file)) {
    const immutable = path.startsWith('/assets/')
    return new Response(Bun.file(file), {
      headers: { 'Cache-Control': immutable ? 'public, max-age=31536000, immutable' : 'no-cache' },
    })
  }
  if (path.startsWith('/assets/')) return c.notFound()
  const index = Bun.file(join(DIST, 'index.html'))
  if (!(await index.exists())) return c.text('前端还没构建：先运行 bun run build', 503)
  return new Response(index, { headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' } })
})

const hostname = await waitForHost(config.host)
const server = Bun.serve({
  hostname,
  port: config.port,
  fetch: app.fetch,
  // 默认 10 秒会掐断 SSE；255 是上限，另有 20 秒一次的 ping
  idleTimeout: 255,
})

console.log(`[cc-remote] 监听 http://${hostname}:${server.port}`)
console.log(`[cc-remote] roots：${roots.join('、') || '（无）'}`)
console.log(`[cc-remote] 并发上限 ${config.maxLive}，空闲 ${config.idleMinutes} 分钟回收子进程`)
const publicUrl = config.publicUrl || `http://${hostname}:${server.port}`
pusher.configure(config.push, publicUrl)
const targets = Object.keys(config.push ?? {})
console.log(`[cc-remote] 推送：${targets.length ? `${targets.join('、')}，深链接 ${publicUrl}/#/s/<id>` : '没配'}`)
if (created) console.log(`[cc-remote] 已生成配置 ${CONFIG_FILE}\n[cc-remote] 登录 token：${config.token}`)
else console.log(`[cc-remote] 登录 token 见 ${CONFIG_FILE}`)

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => {
    sessions.closeAll()
    process.exit(0)
  })
}
