// 状态栏的数据：用量口径、额度换算、会话里的用量与模型信息
import { CWD, idle, Transcript } from './testkit'
import { describe, expect, test } from 'bun:test'
import { renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { SDKAssistantMessage, SDKRateLimitInfo } from '@anthropic-ai/claude-agent-sdk'
import { root } from './testenv'

const { Session } = await import('./session')
const { mergeWindow, QuotaTracker, quotaFromEvent, quotaFromStatusline, readUsage, UsageTracker } = await import('./usage')

const msg = (usage: object, model = 'claude-opus-5-5') => ({ model, usage, content: [] }) as unknown as SDKAssistantMessage['message']

describe('readUsage', () => {
  test('输入侧三项，缓存档位看细分', () => {
    expect(readUsage(msg({ input_tokens: 2, cache_creation_input_tokens: 10, cache_read_input_tokens: 90, cache_creation: { ephemeral_1h_input_tokens: 10, ephemeral_5m_input_tokens: 0 } }))).toEqual({
      input: 2,
      cacheCreation: 10,
      cacheRead: 90,
      ttl: 3600,
    })
    expect(readUsage(msg({ input_tokens: 1, cache_creation: { ephemeral_1h_input_tokens: 0, ephemeral_5m_input_tokens: 5 } }))?.ttl).toBe(300)
    expect(readUsage(msg({ input_tokens: 1, cache_creation: { ephemeral_1h_input_tokens: 0, ephemeral_5m_input_tokens: 0 } }))?.ttl).toBeUndefined()
  })

  test('合成的消息、没有 usage 的不算', () => {
    expect(readUsage(msg({ input_tokens: 0 }, '<synthetic>'))).toBeUndefined()
    expect(readUsage({ model: 'x', content: [] } as unknown as SDKAssistantMessage['message'])).toBeUndefined()
  })

  test('有 iterations 的取最后一次正常请求（跳过 advisor、压缩）', () => {
    const it = (type: string, n: number) => ({ type, input_tokens: n, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: n * 10 })
    const u = readUsage(msg({ input_tokens: 100, cache_read_input_tokens: 5, iterations: [it('message', 1), it('message', 2), it('compaction', 3)] }))
    expect(u).toMatchObject({ input: 2, cacheRead: 20 })
  })
})

describe('UsageTracker', () => {
  test('同一次调用的几帧不重设时间；档位沿用最近一次看到的', () => {
    const t = new UsageTracker()
    t.update(msg({ input_tokens: 1, cache_read_input_tokens: 9, cache_creation: { ephemeral_5m_input_tokens: 3 } }), 1000)
    t.update(msg({ input_tokens: 1, cache_read_input_tokens: 9 }), 2000)
    expect(t.last).toEqual({ input: 1, cacheCreation: 0, cacheRead: 9, at: 1000, ttl: 300 })
    t.update(msg({ input_tokens: 1, cache_read_input_tokens: 20 }), 3000)
    expect(t.last).toEqual({ input: 1, cacheCreation: 0, cacheRead: 20, at: 3000, ttl: 300 })
  })
})

describe('额度', () => {
  test('rate_limit_event：0–1 换成百分比（保留一位），两个窗口一起来', () => {
    const info = { status: 'allowed', rateLimitType: 'seven_day', utilization: 0.83, resetsAt: 200, unifiedWindows: { five_hour: { utilization: 0.163, resetsAt: 100 }, seven_day: { utilization: 0.83, resetsAt: 200 } } }
    expect(quotaFromEvent(info as SDKRateLimitInfo)).toEqual({ five_hour: { used: 16.3, resetsAt: 100 }, seven_day: { used: 83, resetsAt: 200 } })
  })

  test('rate_limit_event 没有 unifiedWindows 时只更新它说的那个窗口', () => {
    expect(quotaFromEvent({ status: 'allowed', rateLimitType: 'five_hour', utilization: 0.5, resetsAt: 100 })).toEqual({ five_hour: { used: 50, resetsAt: 100 } })
  })

  test('终端 statusline 的 stdin：used_percentage 原样用，没有 rate_limits（API key 之类）就是空的', () => {
    const input = { session_id: 'x', rate_limits: { five_hour: { used_percentage: 16.3, resets_at: 100 }, seven_day: { used_percentage: 83, resets_at: 200 } } }
    expect(quotaFromStatusline(input)).toEqual({ five_hour: { used: 16.3, resetsAt: 100 }, seven_day: { used: 83, resetsAt: 200 } })
    expect(quotaFromStatusline({ session_id: 'x' })).toEqual({})
    expect(quotaFromStatusline(null)).toEqual({})
  })

  test('几个进程各报各的：新窗口优先，同一窗口取大的，旧窗口不理', () => {
    const cur = { used: 40, resetsAt: 100 }
    expect(mergeWindow(undefined, cur)).toBe(cur)
    expect(mergeWindow(cur, { used: 2, resetsAt: 118 })).toEqual({ used: 2, resetsAt: 118 })
    expect(mergeWindow(cur, { used: 90, resetsAt: 82 })).toBe(cur)
    expect(mergeWindow(cur, { used: 35, resetsAt: 100 })).toBe(cur)
    expect(mergeWindow(cur, { used: 45, resetsAt: 100 })).toEqual({ used: 45, resetsAt: 100 })
  })

  test('闲着的终端反复报旧数不会盖掉新的，也不重复推', () => {
    const q = new QuotaTracker()
    const seen: unknown[] = []
    q.watch((v) => seen.push(v))
    q.update({ five_hour: { used: 40, resetsAt: 100 }, seven_day: { used: 80, resetsAt: 200 } })
    q.fromEvent({ status: 'allowed', rateLimitType: 'five_hour', utilization: 0.5, resetsAt: 100 })
    q.update({ five_hour: { used: 40, resetsAt: 100 }, seven_day: { used: 80, resetsAt: 200 } })
    q.update({})
    expect(q.current).toEqual({ five_hour: { used: 50, resetsAt: 100 }, seven_day: { used: 80, resetsAt: 200 } })
    expect(seen).toHaveLength(2)
  })

  test('跟着 statusline 存的文件：启动时有就读，改名换上新文件也读到', async () => {
    const file = join(root, 'statusline.json')
    const write = (used: number) => {
      writeFileSync(`${file}.tmp`, JSON.stringify({ rate_limits: { five_hour: { used_percentage: used, resets_at: 100 } } }))
      renameSync(`${file}.tmp`, file)
    }
    write(10)
    const q = new QuotaTracker()
    const next = () => new Promise<unknown>((resolve) => q.watch(resolve))
    let got = next()
    q.follow(file)
    expect(await got).toEqual({ five_hour: { used: 10, resetsAt: 100 } })
    got = next()
    write(20)
    expect(await got).toEqual({ five_hour: { used: 20, resetsAt: 100 } })
  })
})

describe('会话里的状态栏数据', () => {
  test('transcript 读出来的：模型、用量取最后一条 assistant，时间用消息自己的', async () => {
    const t = new Transcript()
    t.user('one')
    t.reply('1')
    const s = new Session(t.id, CWD, 't', () => {}, { fresh: false })
    await s.sync()
    const info = s.info()
    expect(info.model).toBe('claude-haiku-4-5')
    expect(info.usage).toEqual({ input: 1, cacheCreation: 0, cacheRead: 0, at: Date.parse('2026-09-25T00:00:02Z'), ttl: 3600 })
  })

  test('托管会话：init 后问到的上下文上限按模型记着', async () => {
    const s = new Session(crypto.randomUUID(), CWD, 't', () => {}, { fresh: true })
    s.send('one')
    await idle(s)
    await Bun.sleep(5)
    expect(s.info()).toMatchObject({ model: 'haiku', contextWindow: 200_000 })
    expect(s.info().effort).toBeUndefined()
  })
})
