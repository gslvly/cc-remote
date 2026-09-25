import { createHmac, timingSafeEqual } from 'node:crypto'
import type { Context, MiddlewareHandler } from 'hono'
import { deleteCookie, getCookie, setCookie } from 'hono/cookie'

const COOKIE = 'ccr_auth'

function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a)
  const y = Buffer.from(b)
  return x.length === y.length && timingSafeEqual(x, y)
}

export function createAuth(token: string) {
  // cookie 里不放 token 本身；换了 token，旧 cookie 自动失效
  const cookieValue = createHmac('sha256', token).update('cc-remote cookie v1').digest('hex')

  const isHttps = (c: Context) =>
    new URL(c.req.url).protocol === 'https:' || c.req.header('x-forwarded-proto') === 'https'

  const login = async (c: Context) => {
    const body = await c.req.json<{ token?: string }>().catch(() => ({}) as { token?: string })
    if (typeof body.token !== 'string' || !safeEqual(body.token.trim(), token)) {
      return c.json({ error: 'token 不对' }, 401)
    }
    setCookie(c, COOKIE, cookieValue, {
      httpOnly: true,
      sameSite: 'Strict',
      secure: isHttps(c),
      path: '/',
      maxAge: 60 * 60 * 24 * 365,
    })
    return c.json({ ok: true })
  }

  const logout = (c: Context) => {
    deleteCookie(c, COOKIE, { path: '/' })
    return c.json({ ok: true })
  }

  const require: MiddlewareHandler = async (c, next) => {
    const bearer = c.req.header('authorization')?.match(/^Bearer\s+(.+)$/i)?.[1]
    const cookie = getCookie(c, COOKIE)
    const ok = (bearer && safeEqual(bearer, token)) || (cookie && safeEqual(cookie, cookieValue))
    if (!ok) return c.json({ error: 'unauthorized' }, 401)
    await next()
  }

  return { login, logout, require }
}
