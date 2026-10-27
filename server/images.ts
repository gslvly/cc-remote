// 消息里的图片：缓冲里只记了张数（图太大），手机上看图时按需从 transcript 取。
// key 是人发的那条消息的 uuid，或工具调用的 id（Read 读图片，图在 tool_result 里）
import type { SDKSessionInfo } from '@anthropic-ai/claude-agent-sdk'
import { Hono } from 'hono'
import type { ImageAttachment } from '../shared/protocol'
import { openTranscript } from './activity'
import type { SessionManager } from './manager'

/** 刚发的图：前面还在跑时消息排着队，transcript 里还没有，先从这里取。只留最近几条 */
const sent = new Map<string, ImageAttachment[]>()
const KEEP_SENT = 8

export function rememberSent(uuid: string, images: ImageAttachment[]) {
  if (!images.length) return
  sent.set(uuid, images)
  if (sent.size > KEEP_SENT) sent.delete(sent.keys().next().value!)
}

const TYPES = new Set<unknown>(['image/jpeg', 'image/png', 'image/gif', 'image/webp'] satisfies ImageAttachment['mediaType'][])

type Block = { type?: string; tool_use_id?: string; content?: unknown; source?: { type?: string; media_type?: unknown; data?: unknown } }
const blocks = (content: unknown): Block[] => (Array.isArray(content) ? content.filter((b) => b && typeof b === 'object') : [])

/** transcript 的一行里，key 那条的第 n 张图（从 0 数）；不是这一行返回空 */
export function imageIn(line: string, key: string, n: number): ImageAttachment | undefined {
  const m = JSON.parse(line) as { uuid?: string; message?: { content?: unknown } }
  const content = blocks(m.message?.content)
  const own = m.uuid === key ? content : blocks(content.find((b) => b.type === 'tool_result' && b.tool_use_id === key)?.content)
  const src = own.filter((b) => b.type === 'image')[n]?.source
  if (src?.type !== 'base64' || typeof src.data !== 'string' || !TYPES.has(src.media_type)) return
  return { mediaType: src.media_type as ImageAttachment['mediaType'], data: src.data }
}

export async function findImage(s: Pick<SDKSessionInfo, 'sessionId' | 'cwd'>, key: string, n: number) {
  const hit = sent.get(key)?.[n]
  if (hit) return hit
  const f = await openTranscript(s)
  if (!f) return
  try {
    for await (const line of f.readLines()) {
      // key 也会出现在别的行（下一条的 parentUuid、发起调用的 tool_use），imageIn 认得出来
      if (!line.includes(key) || !line.includes('"type":"image"')) continue
      try {
        const img = imageIn(line, key, n)
        if (img) return img
      } catch {}
    }
  } finally {
    await f.close()
  }
}

/** GET /:id/images/:key/:n：同一个 key 的图不会变，让浏览器一直缓存 */
export function imageRoutes(sessions: SessionManager) {
  const r = new Hono()
  r.get('/:id/images/:key/:n', async (c) => {
    const id = c.req.param('id')
    const s = sessions.get(id) ?? (await sessions.open(id))
    if (!s) return c.json({ error: '会话不存在' }, 404)
    const img = await findImage({ sessionId: id, cwd: s.cwd }, c.req.param('key'), Number(c.req.param('n')) || 0)
    if (!img) return c.json({ error: '找不到这张图' }, 404)
    return c.body(Buffer.from(img.data, 'base64'), 200, {
      'Content-Type': img.mediaType,
      'Cache-Control': 'private, max-age=31536000, immutable',
    })
  })
  return r
}
