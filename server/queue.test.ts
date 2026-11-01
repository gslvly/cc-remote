// 一轮跑着时发的消息：CLI 排着，收进去才进缓冲；立即发送
import { CWD, idle, lines, release, spawned, Transcript } from './testkit'
import { expect, test } from 'bun:test'

const { Session } = await import('./session')

const fresh = () => new Session(new Transcript().id, CWD, 't', () => {}, { fresh: true })

test('跑着时发的先排着、不进缓冲；轮到它时才进，排在上一轮的结果后面；回收后对齐不重复', async () => {
  const s = fresh()
  s.send('slow one')
  s.send('two')
  expect(s.info().queued).toEqual([{ uuid: expect.any(String), text: 'two' }])
  expect(lines(s)).not.toContain('> two')

  release()
  await idle(s)
  expect(lines(s)).toEqual(['> slow one', 'system:init', 're: slow one', 'result:success', '> two', 'system:init', 're: two', 'result:success'])
  expect(s.info().queued).toBeUndefined()

  s.sleep()
  const n = s.lastSeq
  await s.sync()
  expect(s.lastSeq).toBe(n)
})

test('立即发送：还排着就中断这一轮；已经收进去了就不打断', async () => {
  const s = fresh()
  s.send('slow a')
  s.send('b')
  const { uuid } = s.info().queued![0]!
  await s.sendNow(uuid)
  expect(spawned.at(-1)!.interrupts).toBe(1)
  await idle(s)
  expect(lines(s).filter((l) => l.startsWith('>'))).toEqual(['> slow a', '> b'])

  await s.sendNow(uuid)
  expect(spawned.at(-1)!.interrupts).toBe(1)
  s.close()
})

test('子进程停了，还排着的报没发出去', async () => {
  const s = fresh()
  s.send('slow x')
  s.send('y')
  s.close()
  expect(lines(s)).toContain('error 没发出去：y')
  expect(s.info().queued).toBeUndefined()
  release()
})
