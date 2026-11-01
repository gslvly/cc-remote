// /api/sessions 下的路由：开会话、内容流、发消息、审批、切模式模型、打断、回退、关掉删除。图片的在 images.ts，组合进来
import { type Context, Hono } from 'hono'
import type {
  BashBody,
  CreateSessionBody,
  ImageAttachment,
  PermissionDecisionBody,
  RewindBody,
  RewindRestore,
  SendMessageBody,
  SendNowBody,
  SetModeBody,
  SetModelBody,
  StreamHello,
  SwitchableMode,
} from '../shared/protocol'
import { CLEAR_COMMAND } from './catalog'
import { checkDir } from './fs'
import { imageRoutes } from './images'
import { LimitError, type SessionManager } from './manager'
import { ConflictError, type EventId } from './session'
import { sse } from './sse'

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
const RESTORES = new Set<unknown>(['both', 'conversation', 'code'] satisfies RewindRestore[])
const EFFORTS = new Set<unknown>(['low', 'medium', 'high', 'xhigh', 'max', null] satisfies SetModelBody['effort'][])
/** 别名或完整 id，可能带 [1m] 这类后缀 */
const MODEL_ID = /^[\w.\-[\]]+$/

/** /clear 会让子进程换会话 id（见 catalog.ts），手机上不让发 */
const CLEARED = { error: '手机上开新会话请用标签条的 [+]' }

const IMAGE_TYPES = new Set<unknown>(['image/jpeg', 'image/png', 'image/gif', 'image/webp'] satisfies ImageAttachment['mediaType'][])
/** API 的上限：单张 base64 后 5MB；一条消息的张数自己定个数 */
const MAX_IMAGE = 5 * 1024 * 1024
const MAX_IMAGES = 20

/** 图片不对的原因。坏图会写进 transcript，之后每一轮都报错，所以发之前先拦 */
function badImages(images: unknown): string | undefined {
  if (images === undefined) return
  if (!Array.isArray(images)) return '图片格式不对'
  if (images.length > MAX_IMAGES) return `一次最多 ${MAX_IMAGES} 张图片`
  for (const i of images as Partial<ImageAttachment>[]) {
    if (!IMAGE_TYPES.has(i?.mediaType)) return '只支持 JPEG、PNG、GIF、WebP 图片'
    if (typeof i.data !== 'string' || !i.data) return '图片格式不对'
    if (i.data.length > MAX_IMAGE) return '图片超过 5MB'
  }
}

export function sessionRoutes(sessions: SessionManager, roots: string[]) {
  const r = new Hono()

  r.get('/', (c) => c.json(sessions.list()))

  r.post('/', async (c) => {
    const { images, permissionMode: mode, model, effort, ...body } = await c.req.json<CreateSessionBody>()
    const prompt = body.prompt?.trim() ?? ''
    const bad = badImages(images)
    if (bad) return c.json({ error: bad }, 400)
    if (!prompt && !images?.length) return c.json({ error: 'prompt 不能为空' }, 400)
    if (CLEAR_COMMAND.test(prompt)) return c.json(CLEARED, 400)
    if (mode !== undefined && !MODES.has(mode)) return c.json({ error: '权限模式不对' }, 400)
    if (model !== undefined && !MODEL_ID.test(model)) return c.json({ error: '模型不对' }, 400)
    // null 是「回到默认」，开新会话时没有意义
    if (effort !== undefined && (effort === null || !EFFORTS.has(effort))) return c.json({ error: 'effort 不对' }, 400)
    const dir = await checkDir(body.cwd, roots)
    if (!dir.ok) return c.json({ error: dir.error }, dir.status)
    try {
      return c.json((await sessions.create(dir.path, prompt, { images, mode, model, effort })).info())
    } catch (e) {
      return commandError(c, e)
    }
  })

  // 不在内存里的会话（历史会话、终端会话）按 id 从 transcript 载入
  r.get('/:id', async (c) => {
    const s = await sessions.open(c.req.param('id'))
    return s ? c.json(s.info()) : c.json(NOT_FOUND, 404)
  })

  // 内容流：只连当前在看的会话。浏览器自动重连带 Last-Event-ID 头，手动重连（切回来、回到前台）带 ?after=
  r.get('/:id/events', async (c) => {
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

  r.route('/', imageRoutes(sessions))
  // 上滑加载更早的事件
  r.get('/:id/history', async (c) => {
    const s = await sessions.open(c.req.param('id'))
    if (!s) return c.json(NOT_FOUND, 404)
    return c.json(s.history(Number(c.req.query('before')) || 0))
  })

  // 历史会话发消息就 resume；终端还占着的不行（只读）
  r.post('/:id/messages', async (c) => {
    const s = await sessions.open(c.req.param('id'))
    if (!s) return c.json(NOT_FOUND, 404)
    const { text = '', images } = await c.req.json<SendMessageBody>()
    const bad = badImages(images)
    if (bad) return c.json({ error: bad }, 400)
    if (!text.trim() && !images?.length) return c.json({ error: '消息不能为空' }, 400)
    if (CLEAR_COMMAND.test(text.trim())) return c.json(CLEARED, 400)
    try {
      await sessions.send(s, text, images)
    } catch (e) {
      return commandError(c, e)
    }
    return c.json({ ok: true })
  })

  // ! 命令（终端里的 shell 模式）：开始跑就返回，输入输出经内容流到达
  r.post('/:id/bash', async (c) => {
    const s = await sessions.open(c.req.param('id'))
    if (!s) return c.json(NOT_FOUND, 404)
    const { command } = await c.req.json<BashBody>()
    if (typeof command !== 'string' || !command.trim()) return c.json({ error: '命令不能为空' }, 400)
    try {
      await sessions.bash(s, command.trim())
    } catch (e) {
      return commandError(c, e)
    }
    return c.json({ ok: true })
  })

  r.post('/:id/permissions/:reqId', async (c) => {
    const s = sessions.get(c.req.param('id'))
    if (!s) return c.json(NOT_FOUND, 404)
    const body = await c.req.json<PermissionDecisionBody>()
    if (body.behavior !== 'allow' && body.behavior !== 'deny') return c.json({ error: 'behavior 不对' }, 400)
    if (body.behavior === 'allow' && body.mode !== undefined && !MODES.has(body.mode)) return c.json({ error: '权限模式不对' }, 400)
    const ok = s.decide(c.req.param('reqId'), body)
    return ok ? c.json({ ok: true }) : c.json({ error: '请求已处理或已失效' }, 409)
  })

  // 切权限模式（终端里的 Shift+Tab）；历史会话也能先切好，发消息时带上
  r.post('/:id/mode', async (c) => {
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

  // 切模型、effort（终端里的 /model、/effort）；同 mode，历史会话也能先切好
  r.post('/:id/model', async (c) => {
    const s = await sessions.open(c.req.param('id'))
    if (!s) return c.json(NOT_FOUND, 404)
    const body = await c.req.json<SetModelBody>()
    if (body.model !== undefined && !MODEL_ID.test(body.model)) return c.json({ error: '模型不对' }, 400)
    if (body.effort !== undefined && !EFFORTS.has(body.effort)) return c.json({ error: 'effort 不对' }, 400)
    try {
      await s.setModel({ model: body.model, effort: body.effort })
    } catch (e) {
      if (e instanceof ConflictError) return commandError(c, e)
      return c.json({ error: e instanceof Error ? e.message : String(e) }, 500)
    }
    return c.json(s.info())
  })

  r.post('/:id/interrupt', async (c) => {
    const s = sessions.get(c.req.param('id'))
    if (!s) return c.json(NOT_FOUND, 404)
    try {
      await s.interrupt()
    } catch (e) {
      return c.json({ error: e instanceof Error ? e.message : String(e) }, 500)
    }
    return c.json({ ok: true })
  })

  // 排着的消息立即发送：这条还排着才打断这一轮，排着的接着作为新的一轮发出
  r.post('/:id/send-now', async (c) => {
    const s = sessions.get(c.req.param('id'))
    if (!s) return c.json(NOT_FOUND, 404)
    const { uuid } = await c.req.json<SendNowBody>()
    if (typeof uuid !== 'string') return c.json({ error: 'uuid 不对' }, 400)
    try {
      await s.sendNow(uuid)
    } catch (e) {
      return c.json({ error: e instanceof Error ? e.message : String(e) }, 500)
    }
    return c.json({ ok: true })
  })

  // 回退到某条用户消息之前（终端里按两下 Esc），代码、对话可以只回退一样；dryRun 先预览
  r.post('/:id/rewind', async (c) => {
    const s = await sessions.open(c.req.param('id'))
    if (!s) return c.json(NOT_FOUND, 404)
    const { uuid, restore = 'both', dryRun } = await c.req.json<RewindBody>()
    if (typeof uuid !== 'string' || !uuid) return c.json({ error: '要回退到哪条消息' }, 400)
    if (!RESTORES.has(restore)) return c.json({ error: '回退哪样不对' }, 400)
    try {
      return c.json(await sessions.rewind(s, uuid, restore, !!dryRun))
    } catch (e) {
      if (e instanceof ConflictError || e instanceof LimitError) return commandError(c, e)
      return c.json({ error: `回退失败：${e instanceof Error ? e.message : String(e)}` }, 500)
    }
  })

  // 关掉会话：停子进程、出标签条；不在内存里的本来就是关着的。终端里正跑着的归终端管
  r.post('/:id/close', (c) => {
    const s = sessions.get(c.req.param('id'))
    if (s?.terminal === 'running') return c.json({ error: '终端里的会话要在终端里退出' }, 409)
    s?.dismiss()
    return c.json({ ok: true })
  })

  // 删会话：连 transcript 一起删，找不回来。正在跑的先中断；终端里还开着的不行
  r.post('/:id/delete', async (c) => {
    try {
      return (await sessions.remove(c.req.param('id'))) ? c.json({ ok: true }) : c.json(NOT_FOUND, 404)
    } catch (e) {
      if (e instanceof ConflictError) return commandError(c, e)
      return c.json({ error: `删除失败：${e instanceof Error ? e.message : String(e)}` }, 500)
    }
  })

  return r
}
