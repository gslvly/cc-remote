import { createMemo } from 'solid-js'
import { go } from './router'
import { checkBuild } from './update'

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message)
  }
}

export async function api<T = unknown>(path: string, body?: unknown): Promise<T> {
  const res = await fetch(`/api${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  checkBuild(res)
  if (res.status === 401 && path !== '/login') {
    go.login()
    throw new ApiError(401, '需要登录')
  }
  const data = await res.json().catch(() => ({}))
  if (!res.ok) throw new ApiError(res.status, data.error ?? `HTTP ${res.status}`)
  return data as T
}

const last = new Map<string, unknown>()

/**
 * 页面上的 GET，返回异步 memo：读它的地方放在 <Loading> / <Errored> 里。
 * 上次取到的先顶着（loadingValue，不挂起），同时重新取，切回页面时不再闪一下「加载中」
 */
export function cachedGet<T>(path: string) {
  const prev = last.get(path) as T | undefined
  const get = async () => {
    const v = await api<T>(path)
    last.set(path, v)
    return v
  }
  return prev === undefined ? createMemo(get) : createMemo(get, { loadingValue: prev })
}
