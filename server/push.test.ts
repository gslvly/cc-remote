// 推送：发给 Bark / ntfy 的请求、各种提醒的文字、什么时候推
import { CWD, idle, spawned, Transcript } from './testkit'
import { afterAll, afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test'
import type { SDKRateLimitInfo, SDKResultMessage } from '@anthropic-ai/claude-agent-sdk'
import type { PermissionRequest } from '../shared/protocol'

const { Session } = await import('./session')
const { approvalNotice, doneNotice, pusher, pushRequests, quotaNotice, quotaRejected } = await import('./push')

const s = { id: 'b3f1c2d4-5e6f-4a7b-8c9d-0e1f2a3b4c5d', title: '给 cc-remote 加推送' }
const LINK = `http://100.101.102.103:8686/#/s/${s.id}`
/** 实测的 Bash 审批请求：没有 title，description 是 Claude 的转述 */
const bash: PermissionRequest = {
  id: 'r1',
  toolName: 'Bash',
  displayName: 'Bash',
  description: 'Write current date to stamp.txt',
  input: { command: 'date > stamp.txt', description: 'Write current date to stamp.txt' },
}
const rejected: SDKRateLimitInfo = { status: 'rejected', rateLimitType: 'five_hour', resetsAt: 1790352000, isUsingOverage: false }
const result = (text: string) => ({ type: 'result', subtype: 'success', is_error: false, result: text }) as SDKResultMessage

describe('发给推送服务的请求', () => {
  test('Bark：POST {server}/push；待批准是时效性通知', () => {
    const [r] = pushRequests({ bark: { key: 'k' } }, approvalNotice(s, bash), LINK)
    expect(r!.url).toBe('https://api.day.app/push')
    expect(JSON.parse(r!.init.body as string)).toEqual({
      device_key: 'k',
      title: '待批准 · 给 cc-remote 加推送',
      body: 'Bash：date > stamp.txt',
      url: LINK,
      group: 'cc-remote',
      level: 'timeSensitive',
    })
  })

  test('ntfy：POST 到服务根地址，topic 放 JSON 里；自建的带令牌；一轮结束是普通优先级', () => {
    const [r] = pushRequests({ ntfy: { server: 'https://ntfy.example.com/', topic: 'ccr-x7k2', token: 'tk_abc' } }, doneNotice(s, result('推送已接好')), LINK)
    expect(r!.url).toBe('https://ntfy.example.com')
    expect(r!.init.headers).toMatchObject({ Authorization: 'Bearer tk_abc' })
    expect(JSON.parse(r!.init.body as string)).toEqual({ topic: 'ccr-x7k2', title: '完成 · 给 cc-remote 加推送', message: '推送已接好', click: LINK })
  })

  test('两个都配就都发；都没配不发', () => {
    expect(pushRequests({ bark: { key: 'k' }, ntfy: { topic: 't' } }, doneNotice(s, result('ok')), LINK).map((r) => r.url)).toEqual([
      'https://api.day.app/push',
      'https://ntfy.sh',
    ])
    expect(pushRequests({}, doneNotice(s, result('ok')), LINK)).toEqual([])
  })
})

describe('提醒的文字', () => {
  test('提问、计划审批', () => {
    const ask = approvalNotice(s, { id: 'r2', toolName: 'AskUserQuestion', input: { questions: [{ question: '推送用 Bark 还是 ntfy？', header: '推送', options: [], multiSelect: false }] } })
    expect([ask.title, ask.body]).toEqual(['等你回答 · 给 cc-remote 加推送', '推送用 Bark 还是 ntfy？'])
    const plan = approvalNotice(s, { id: 'r3', toolName: 'ExitPlanMode', input: { plan: '# 加推送\n\n1. 新建 server/push.ts' } })
    expect([plan.title, plan.body]).toEqual(['计划待批准 · 给 cc-remote 加推送', '加推送 1. 新建 server/push.ts'])
  })

  test('一轮结束：回复压成一行、太长截断；出错的说原因', () => {
    const long = doneNotice(s, result(`改好了。\n\n${'很长的总结'.repeat(40)}`))
    expect(long.body.startsWith('改好了。 很长的总结')).toBe(true)
    expect(long.body.length).toBe(120)
    const err = doneNotice(s, { type: 'result', subtype: 'error_max_turns', is_error: true, errors: ['Reached maximum number of turns (5)'] } as SDKResultMessage)
    expect([err.title, err.body]).toEqual(['出错 · 给 cc-remote 加推送', 'Reached maximum number of turns (5)'])
  })

  test('额度被拒：哪个窗口、几点重置；超额顶上的不算被拒', () => {
    expect(quotaNotice(s, rejected).body).toMatch(/^5 小时额度用完了，\d+\/\d+ \d\d:\d\d 重置$/)
    expect(quotaRejected(rejected)).toBe(true)
    expect(quotaRejected({ ...rejected, isUsingOverage: true })).toBe(false)
    expect(quotaRejected({ status: 'allowed_warning', rateLimitType: 'seven_day', utilization: 0.9 })).toBe(false)
  })
})

describe('什么时候推', () => {
  let sent: { title: string; message: string; click: string }[]
  beforeEach(() => {
    sent = []
    pusher.configure({ ntfy: { server: 'http://127.0.0.1:1', topic: 't' } }, 'http://100.101.102.103:8686/')
    spyOn(globalThis, 'fetch').mockImplementation((async (_url: string, init: RequestInit) => {
      sent.push(JSON.parse(init.body as string))
      return new Response('{}')
    }) as unknown as typeof fetch)
  })
  afterEach(() => (globalThis.fetch as unknown as { mockRestore(): void }).mockRestore())
  afterAll(() => pusher.configure(undefined, ''))

  test('会话里：一轮结束、待批准都推，深链接进这个会话', async () => {
    const t = new Transcript()
    const sess = new Session(t.id, CWD, '给 cc-remote 加推送', () => {}, { fresh: true })
    sess.send('one')
    await idle(sess)
    void spawned.at(-1)!.options.canUseTool!('Bash', bash.input, { signal: new AbortController().signal, displayName: 'Bash', description: bash.description, toolUseID: 'tu1', requestId: 'r1' })
    expect(sent.map((n) => [n.title, n.message])).toEqual([
      ['完成 · 给 cc-remote 加推送', 're: one'],
      ['待批准 · 给 cc-remote 加推送', 'Bash：date > stamp.txt'],
    ])
    expect(sent[0]!.click).toBe(`http://100.101.102.103:8686/#/s/${t.id}`)
    sess.close()
  })

  test('概览流连着（手机在前台）就不推，断开后照推', () => {
    const unview = pusher.view()
    pusher.approval(s, bash)
    unview()
    unview()
    pusher.approval(s, bash)
    expect(sent.length).toBe(1)
  })

  test('额度被拒只推一次，随后出错的 result 不再推；下一轮照常', () => {
    pusher.rateLimit(s, rejected)
    pusher.rateLimit(s, rejected)
    pusher.done(s, { type: 'result', subtype: 'success', is_error: true, result: "You've hit your limit" } as SDKResultMessage)
    pusher.done(s, result('ok'))
    expect(sent.map((n) => n.title)).toEqual(['额度用完 · 给 cc-remote 加推送', '完成 · 给 cc-remote 加推送'])
  })
})
