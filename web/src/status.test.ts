import { describe, expect, test } from 'bun:test'
import { cacheParts, ctxParts, fmtRemaining, fmtSize, modelLabel, modelName, quotaParts } from './status'

const NOW = Date.parse('2026-09-25T12:00:00Z')
const at = (sec: number) => NOW / 1000 + sec

describe('状态栏数据', () => {
  test('模型名', () => {
    expect(modelName('claude-opus-5-5')).toBe('Opus 5.5')
    expect(modelName('claude-sonnet-5')).toBe('Sonnet 5')
    expect(modelName('claude-haiku-4-5-20251001')).toBe('Haiku 4.5')
  })

  test('模型 · 上限 · effort，不知道的项不显示', () => {
    const i = { model: 'claude-opus-5-5', contextWindow: 1_000_000, effort: 'xhigh' } as never
    expect(modelLabel(i)).toBe('Opus 5.5 · 1M · xhigh')
    expect(fmtSize(200_000)).toBe('200k')
    expect(modelLabel({ model: 'claude-haiku-4-5-20251001' } as never)).toBe('Haiku 4.5')
  })

  test('距重置', () => {
    expect(fmtRemaining(at(86400 + 2 * 3600 + 59), NOW)).toBe('1d2h')
    expect(fmtRemaining(at(3 * 3600 + 5 * 60 + 30), NOW)).toBe('3h05m')
    expect(fmtRemaining(at(12 * 60 + 59), NOW)).toBe('12m')
    expect(fmtRemaining(at(0), NOW)).toBe('即将重置')
  })

  test('上下文：按上限算百分比；不知道上限时只有 k', () => {
    const u = { input: 2, cacheCreation: 4518, cacheRead: 445_480, at: NOW, ttl: 3600 }
    expect(ctxParts(u, 1_000_000)).toEqual({ pct: 45, k: 450 })
    expect(ctxParts(u, undefined)).toEqual({ pct: undefined, k: 450 })
  })

  test('缓存：命中率向下取整，倒计时按分钟、不到一分钟按秒，过期了没有', () => {
    const u = { input: 2, cacheCreation: 18, cacheRead: 980, at: NOW - 8 * 60 * 1000, ttl: 3600 }
    expect(cacheParts(u, NOW)).toEqual({ hit: 98, left: '52m' })
    expect(cacheParts({ ...u, ttl: 300, at: NOW - 250_000 }, NOW)?.left).toBe('50s')
    expect(cacheParts({ ...u, ttl: 300 }, NOW)?.left).toBeUndefined()
    expect(cacheParts(undefined, NOW)).toBeUndefined()
  })

  test('额度：显示剩余', () => {
    expect(quotaParts({ used: 16.3, resetsAt: at(2 * 3600 + 13 * 60) }, NOW)).toEqual({ left: 84, resets: '2h13m' })
  })
})
