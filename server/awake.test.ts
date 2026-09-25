// 防睡眠的开关时机
import { describe, expect, test } from 'bun:test'
import { Awake } from './awake'

function fakeAwake(tailMs = 30) {
  const log: string[] = []
  const awake = new Awake(tailMs, () => {
    log.push('spawn')
    return { kill: () => log.push('kill') }
  })
  return { awake, log }
}

describe('Awake', () => {
  test('忙时只起一个；空闲后留一会儿再放', async () => {
    const { awake, log } = fakeAwake()
    awake.set(true)
    awake.set(true)
    awake.set(false)
    awake.set(false)
    expect(log).toEqual(['spawn'])
    await Bun.sleep(60)
    expect(log).toEqual(['spawn', 'kill'])
    expect(awake.holding).toBe(false)
  })

  test('留着的时候又忙了：接着用，不重起', async () => {
    const { awake, log } = fakeAwake()
    awake.set(true)
    awake.set(false)
    awake.set(true)
    await Bun.sleep(60)
    expect(log).toEqual(['spawn'])
    expect(awake.holding).toBe(true)
    awake.release()
  })

  test('一直空闲就不起', () => {
    const { awake, log } = fakeAwake()
    awake.set(false)
    expect(log).toEqual([])
  })
})
