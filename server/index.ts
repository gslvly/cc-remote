import { listSessions, type SDKSessionInfo } from '@anthropic-ai/claude-agent-sdk'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { join, posix } from 'node:path'
import { Hono } from 'hono'
import type { DirInfo, DirSessions, FavoriteBody, RecentDir } from '../shared/protocol'
import { byActivity } from './activity'
import { catalog } from './catalog'
import { createAuth } from './auth'
import { localClaude } from './claudeBin'
import { CONFIG_DIR, CONFIG_FILE, expandHome, loadConfig, resolveRoots, waitForHost } from './config'
import { Favorites } from './favorites'
import { checkDir, dirEntry, gitBranch, within } from './fs'
import { fsRoutes } from './fsRoutes'
import { listen } from './listen'
import { SessionManager } from './manager'
import { pusher } from './push'
import { listenUrls, printLoginQr } from './qr'
import { pruneOnStart, sdkRoutes } from './sdk'
import { sessionRoutes } from './sessionRoutes'
import { sse } from './sse'
import { isEmpty, titleOf, withCwd } from './transcript'
import { quota } from './usage'
import { validSubscription, WebPush } from './webpush'

// 输出到文件时（后台服务、e2e）每行带上时间
if (!process.stdout.isTTY) {
  for (const k of ['log', 'warn', 'error'] as const) {
    const write = console[k]
    console[k] = (...args: unknown[]) => write(new Date().toLocaleString('sv-SE'), ...args)
  }
}

const { config, created } = loadConfig()
const auth = createAuth(config.token)
const roots = resolveRoots(config.roots)
localClaude.configure(config.claude ? expandHome(config.claude) : undefined)
const sessions = new SessionManager({ maxLive: config.maxLive, idleMinutes: config.idleMinutes, roots })
const favorites = new Favorites()
const webPush = new WebPush(join(CONFIG_DIR, 'webpush.json'))
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
  const all = await byActivity(await Promise.all((await listSessions({ limit: 500 })).filter((s) => !isEmpty(s)).map(withCwd)))
  const byCwd = new Map<string, Omit<RecentDir, 'lastTitle'> & { latest: SDKSessionInfo }>()
  for (const s of all) {
    if (!s.cwd) continue
    const d = byCwd.get(s.cwd)
    if (!d) byCwd.set(s.cwd, { cwd: s.cwd, lastModified: s.lastModified, sessions: 1, latest: s })
    else {
      d.sessions++
      if (s.lastModified > d.lastModified) Object.assign(d, { lastModified: s.lastModified, latest: s })
    }
  }
  const usable = await Promise.all(
    [...byCwd.values()].map(async ({ latest, ...d }): Promise<RecentDir | undefined> =>
      (await checkDir(d.cwd, roots)).ok ? { ...d, lastTitle: await titleOf(latest) } : undefined,
    ),
  )
  const dirs = usable
    .filter((d) => d !== undefined)
    .sort((a, b) => b.lastModified - a.lastModified)
    .slice(0, 30)
  return c.json(dirs)
})

// 选目录：列子目录、新建 / 删文件夹。正在跑的会话所在的目录不让删
api.route(
  '/fs',
  fsRoutes(roots, (dir) => sessions.list().some((s) => s.state !== 'idle' && within(s.cwd, dir))),
)

// 升级 SDK：重启会打断托管会话，有在跑的就不升；终端里的会话不受影响
api.route(
  '/sdk',
  sdkRoutes(() => sessions.list().some((s) => !s.terminal && s.state !== 'idle'), shutdown),
)

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
  // SDK 按文件修改时间排序分页，要按最后活动时间排就得全取出来自己分
  const list = await byActivity((await listSessions({ dir: dir.path, includeWorktrees: false })).filter((s) => !isEmpty(s)))
  return c.json<DirSessions>({
    sessions: await Promise.all(
      list.slice(offset, offset + DIR_PAGE).map(async (s) => ({
        id: s.sessionId,
        title: await titleOf(s),
        lastModified: s.lastModified,
        branch: s.gitBranch,
      })),
    ),
    more: list.length > offset + DIR_PAGE,
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

// 网页推送：页面在 HTTPS 下、用户点了开启才来订阅（见 web/src/notify.ts）
api.get('/push/key', (c) => c.json({ key: webPush.publicKey }))
api.post('/push/subscribe', async (c) => {
  const sub = await c.req.json()
  if (!validSubscription(sub)) return c.json({ error: '订阅格式不对' }, 400)
  webPush.add(sub)
  return c.json({ ok: true })
})
api.post('/push/unsubscribe', async (c) => {
  const { endpoint } = await c.req.json<{ endpoint?: unknown }>()
  webPush.remove(String(endpoint))
  return c.json({ ok: true })
})

api.route('/sessions', sessionRoutes(sessions, roots))

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

// 输入框里打 / 时的命令列表、切模型的列表。这个目录没有活着的子进程时要现起一个问，第一次慢一两秒
api.get('/catalog', async (c) => {
  const dir = await checkDir(c.req.query('cwd'), roots)
  if (!dir.ok) return c.json({ error: dir.error }, dir.status)
  try {
    return c.json(await catalog(dir.path))
  } catch (e) {
    return c.json({ error: `取命令列表失败：${e instanceof Error ? e.message : String(e)}` }, 500)
  }
})

const app = new Hono()
app.route('/api', api)

// 静态文件：index.html、sw.js、manifest、图标都 no-cache（每次向服务端确认）；/assets/* 文件名带 hash，永久缓存。
// URL 路径按 / 处理，拼成本机路径后再判断在不在 dist 里（Windows 上是 \）
app.get('*', async (c) => {
  const path = posix.normalize(decodeURIComponent(new URL(c.req.url).pathname))
  const file = join(DIST, path)
  if (within(file, DIST) && !path.endsWith('/') && existsSync(file) && !isDir(file)) {
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
const server = listen(hostname, config, app.fetch)

const anyHost = hostname === '0.0.0.0'
const urls = listenUrls(hostname, server.port ?? config.port)
console.log(`[cc-remote] 监听${anyHost ? '所有网卡' : ''} ${urls.join('、') || `http://127.0.0.1:${server.port}`}`)
if (anyHost) console.log('[cc-remote] 同一局域网 / 组网里的设备都能打开登录页，token 别外泄；只想在某个网卡上听，就把 host 写成它的 IP')
console.log(`[cc-remote] roots：${roots.join('、') || '（无）'}`)
console.log(`[cc-remote] 并发上限 ${config.maxLive}，空闲 ${config.idleMinutes} 分钟回收子进程`)
console.log(`[cc-remote] claude：${localClaude.describe()}`)
pruneOnStart()
// 终端会话的额度：终端 statusline 把 stdin 存到这里（见 README「状态栏」）
quota.follow(join(CONFIG_DIR, 'statusline.json'))
// 听所有网卡时取第一个网卡地址，不对就在配置里写 publicUrl
const publicUrl = config.publicUrl || urls[0] || `http://127.0.0.1:${server.port}`
pusher.configure(config.push, publicUrl, webPush)
const targets = Object.keys(config.push ?? {})
console.log(`[cc-remote] 推送：${targets.length ? `${targets.join('、')}，深链接 ${publicUrl}/#/s/<id>` : '没配'}；网页推送 ${webPush.count} 台设备`)
if (created) console.log(`[cc-remote] 已生成配置 ${CONFIG_FILE}\n[cc-remote] 登录 token：${config.token}`)
else console.log(`[cc-remote] 登录 token 见 ${CONFIG_FILE}，登录二维码用 bun run qr 出`)
// 只在首次启动、终端前台跑时打码：之后重启不刷屏，后台服务的日志里也不留；要再出码用 bun run qr
if (created && process.stdout.isTTY) printLoginQr(publicUrl, config.token, urls)
// 防睡眠、开机自启都由用户按自己的系统配，服务端不管
console.log('[cc-remote] 提示：电脑睡着了手机就连不上，要随时能连请在系统设置里关掉自动睡眠（见 README「需要你自己配的」）')

function shutdown() {
  sessions.closeAll()
  process.exit(0)
}

for (const sig of ['SIGINT', 'SIGTERM'] as const) process.on(sig, shutdown)
