// 回退到某条用户消息之前（Session.rewind）：代码和对话一起、只回退对话、只还原代码
import { CWD, idle, lines, noCheckpoint, spawned, Transcript, watch } from './testkit'
import { describe, expect, test } from 'bun:test'

const { Session } = await import('./session')

/** 历史会话：两轮对话，返回第一、二轮用户消息和第一轮回复的 uuid */
async function twoTurns() {
  const t = new Transcript()
  const u1 = t.user('one')
  const a1 = t.reply('1')
  const u2 = t.user('two')
  t.reply('2')
  const s = new Session(t.id, CWD, 't', () => {}, { fresh: false })
  await s.sync()
  return { t, s, u1, a1, u2 }
}

const lastSpawn = () => spawned.at(-1)!
const A = `${CWD}/a.txt`

describe('回退', () => {
  test('代码和对话一起：文件还原，缓冲截到第一轮，下次起子进程从截断处接着；之后对齐不重复', async () => {
    const { t, s, a1, u2 } = await twoTurns()
    const got = watch(s)
    const r = await s.rewind(u2, 'both', false)
    expect(r.files).toMatchObject({ canRewind: true, filesChanged: [A] })
    // 现起的子进程 resume 进来、开着检查点，先预览再真还原，用完就停
    expect(lastSpawn().options).toMatchObject({ resume: t.id, enableFileCheckpointing: true })
    expect(lastSpawn().rewinds).toEqual([`dry ${u2}`, `real ${u2}`])
    expect(s.live).toBe(false)
    expect(lines(s)).toEqual(['> one', '1'])
    expect(got).toContain('hello')
    expect(s.info().owned).toBe(true)

    // 还没发新消息：transcript 后面还是回退掉的那些，不追
    await s.sync()
    expect(lines(s)).toEqual(['> one', '1'])

    s.send('two again')
    expect(lastSpawn().options.resumeSessionAt).toBe(a1)
    await idle(s)
    const after = ['> one', '1', '> two again', 'system:init', 're: two again', 'result:success']
    expect(lines(s)).toEqual(after)
    const epoch = s.epoch
    s.sleep()
    await s.sync()
    expect(lines(s)).toEqual(after)
    expect(s.epoch).toBe(epoch)
    // 截断点只用一次
    s.send('three')
    expect(lastSpawn().options.resumeSessionAt).toBeUndefined()
    await idle(s)
  })

  test('预览两样都看：什么都不动，现起的子进程停掉；第一条的对话回退不了', async () => {
    const { s, u1, u2 } = await twoTurns()
    expect(await s.rewind(u2, 'both', true)).toEqual({ files: { canRewind: true, filesChanged: [A], insertions: 1, deletions: 2 } })
    expect(lastSpawn().rewinds).toEqual([`dry ${u2}`])
    expect(s.live).toBe(false)
    expect(lines(s)).toEqual(['> one', '1', '> two', '2'])
    const first = await s.rewind(u1, 'both', true)
    expect(first.files?.canRewind).toBe(true)
    expect(first.conversationBlocked).toContain('第一条')
  })

  test('只还原代码：对话不动，活着的子进程留着；第一条也行', async () => {
    const { s, u1, u2 } = await twoTurns()
    s.send('three')
    await idle(s)
    const n = spawned.length
    const got = watch(s)
    const r = await s.rewind(u2, 'code', false)
    expect(r.files?.canRewind).toBe(true)
    expect(spawned.length).toBe(n)
    expect(lastSpawn().rewinds).toEqual([`dry ${u2}`, `real ${u2}`])
    expect(s.live).toBe(true)
    expect(got).not.toContain('hello')
    await s.rewind(u1, 'code', false)
    expect(lastSpawn().rewinds.at(-1)).toBe(`real ${u1}`)
    expect(lines(s).slice(0, 4)).toEqual(['> one', '1', '> two', '2'])
  })

  test('只回退对话：不碰文件，活着的子进程停掉，下次从截断处接着', async () => {
    const { s, a1, u2 } = await twoTurns()
    s.send('three')
    await idle(s)
    const run = lastSpawn()
    const r = await s.rewind(u2, 'conversation', false)
    expect(r).toEqual({})
    expect(run.rewinds).toEqual([])
    expect(s.live).toBe(false)
    expect(lines(s)).toEqual(['> one', '1'])
    s.send('two again')
    expect(lastSpawn().options.resumeSessionAt).toBe(a1)
    await idle(s)
  })

  test('这条没留底：一起回退报错、什么都不动，只回退对话可以', async () => {
    const { s, u2 } = await twoTurns()
    noCheckpoint.add(u2)
    expect((await s.rewind(u2, 'both', true)).files?.canRewind).toBe(false)
    await expect(s.rewind(u2, 'both', false)).rejects.toThrow('代码还原不了')
    expect(lastSpawn().rewinds).toEqual([`dry ${u2}`])
    expect(lines(s)).toEqual(['> one', '1', '> two', '2'])
    await s.rewind(u2, 'conversation', false)
    expect(lines(s)).toEqual(['> one', '1'])
  })

  test('回退过对话还没发消息：截断点之后的回不去，之前的还能再往前退', async () => {
    const t = new Transcript()
    t.user('one')
    t.reply('1')
    const u2 = t.user('two')
    t.reply('2')
    const u3 = t.user('three')
    t.reply('3')
    const s = new Session(t.id, CWD, 't', () => {}, { fresh: false })
    await s.sync()
    await s.rewind(u3, 'both', false)
    expect(lines(s)).toEqual(['> one', '1', '> two', '2'])
    await expect(s.rewind(u3, 'conversation', false)).rejects.toThrow('没有这条')
    await s.rewind(u2, 'both', false)
    expect(lines(s)).toEqual(['> one', '1'])
  })

  test('第一条的对话、在跑的、终端占着的不行', async () => {
    const { t, s, u1 } = await twoTurns()
    await expect(s.rewind(u1, 'both', false)).rejects.toThrow('第一条')
    await expect(s.rewind(u1, 'conversation', false)).rejects.toThrow('第一条')

    s.send('three')
    await expect(s.rewind(u1, 'code', true)).rejects.toThrow('还在运行')
    await idle(s)

    s.setHolder({ pid: 1, sessionId: t.id, cwd: CWD, status: 'idle', updatedAt: Date.now() })
    await expect(s.rewind(u1, 'code', true)).rejects.toThrow('终端')
  })
})
