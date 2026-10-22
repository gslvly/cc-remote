// 会话的最后活动时间：取 transcript 最后一条的时间，终端 touch 文件改了修改时间也不跟着变
import { CWD, Transcript } from './testkit'
import { expect, test } from 'bun:test'
import { appendFileSync, utimesSync } from 'node:fs'
import { join } from 'node:path'
import { getSessionInfo } from '@anthropic-ai/claude-agent-sdk'
const { CLAUDE_DIR } = await import('./config')
const { byActivity } = await import('./activity')

const file = (t: Transcript) => join(CLAUDE_DIR, 'projects', CWD.replace(/[^a-zA-Z0-9]/g, '-'), `${t.id}.jsonl`)
const at = (iso: string) => ({ extra: { timestamp: iso } })
const order = async (...ts: Transcript[]) =>
  (await byActivity(await Promise.all(ts.map(async (t) => (await getSessionInfo(t.id))!)))).map((s) => [s.sessionId, new Date(s.lastModified).toISOString()])

test('闲着的会话被 touch 过，仍排在后来真聊过的后面；再聊了就到前面', async () => {
  const idle = new Transcript()
  idle.add('user', '早上的', at('2026-09-25T01:00:00.000Z'))
  // 终端退出时写的元数据行不带时间
  appendFileSync(file(idle), JSON.stringify({ type: 'cost-state', sessionId: idle.id, totalCostUSD: 1 }) + '\n')
  const busy = new Transcript()
  busy.add('user', '后来的', at('2026-09-25T02:00:00.000Z'))
  // 终端每小时 touch：修改时间比 busy 新，内容没变
  const touched = new Date(Date.now() + 3600_000)
  utimesSync(file(idle), touched, touched)

  expect(await order(idle, busy)).toEqual([
    [busy.id, '2026-09-25T02:00:00.000Z'],
    [idle.id, '2026-09-25T01:00:00.000Z'],
  ])

  idle.add('user', '又聊了', at('2026-09-25T03:00:00.000Z'))
  utimesSync(file(idle), touched, touched)
  expect((await order(idle, busy))[0]).toEqual([idle.id, '2026-09-25T03:00:00.000Z'])
})

test('最后一条很长（超过一次读的窗口）也取得到它的时间', async () => {
  const t = new Transcript()
  t.add('user', '前面的', at('2026-09-25T01:00:00.000Z'))
  t.add('assistant', [{ type: 'text', text: 'x'.repeat(200_000) }], at('2026-09-25T04:00:00.000Z'))
  expect(await order(t)).toEqual([[t.id, '2026-09-25T04:00:00.000Z']])
})
