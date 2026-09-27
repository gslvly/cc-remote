import { createEffect, createResource, type ResourceReturn } from 'solid-js'
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
    location.hash = '#/login'
    throw new ApiError(401, '需要登录')
  }
  const data = await res.json().catch(() => ({}))
  if (!res.ok) throw new ApiError(res.status, data.error ?? `HTTP ${res.status}`)
  return data as T
}

const last = new Map<string, unknown>()

/**
 * 页面上的 GET：上次取到的先显示着，同时重新取，切回页面时不再闪一下「加载中」。
 * 本地改过的值（mutate）也记下，下次进来不会先显示改之前的
 */
export function cachedResource<T>(path: string): ResourceReturn<T> {
  const prev = last.get(path) as T | undefined
  const res = createResource(() => api<T>(path), prev === undefined ? {} : { initialValue: prev })
  const [r] = res
  createEffect(() => {
    if (!r.error && r.latest !== undefined) last.set(path, r.latest)
  })
  return res
}
