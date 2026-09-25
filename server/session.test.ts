// Session 与 transcript 的对齐（sync）
import { CWD, idle, lines, Transcript, watch } from './testkit'
import { describe, expect, test } from 'bun:test'

const { Session } = await import('./session')

const open = (t: Transcript) => new Session(t.id, CWD, 't', () => {}, { fresh: false })

describe('Session 与 transcript 对齐', () => {
  test('历史会话：整段载入', async () => {
    const t = new Transcript()
    t.user('one')
    t.reply('1')
    const s = open(t)
    await s.sync()
    expect(lines(s)).toEqual(['> one', '1'])
  })

  test('终端接着写：只补新的，epoch 不变；transcript 没变就什么都不发', async () => {
    const t = new Transcript()
    t.user('one')
    t.reply('1')
    const s = open(t)
    await s.sync()
    const epoch = s.epoch
    const got = watch(s)
    t.user('two')
    t.reply('2')
    await s.sync()
    expect(lines(s)).toEqual(['> one', '1', '> two', '2'])
    expect(s.epoch).toBe(epoch)
    expect(got).toEqual(['ev', 'ev'])
    await s.sync()
    expect(got).toEqual(['ev', 'ev'])
  })

  test('终端里的斜杠命令和输出转成输入和灰色提示，包装消息不显示但记住位置', async () => {
    const t = new Transcript()
    t.user('<local-command-caveat>Caveat: …</local-command-caveat>')
    t.user('<command-name>/model</command-name>\n<command-args>haiku</command-args>')
    t.user('<local-command-stdout>Set model to \x1b[1mhaiku\x1b[22m</local-command-stdout>')
    const s = open(t)
    await s.sync()
    t.user('hi')
    t.reply('hello')
    await s.sync()
    expect(lines(s)).toEqual(['> /model haiku', 'note Set model to haiku', '> hi', 'hello'])
  })

  test('终端里回退后另起一支：换 epoch 整段重建，看着的收到新的 hello', async () => {
    const t = new Transcript()
    t.user('one')
    const a1 = t.reply('1')
    t.user('two')
    t.reply('2')
    const s = open(t)
    await s.sync()
    const epoch = s.epoch
    const got = watch(s)
    t.user('two again', { parent: a1 })
    t.reply('2b')
    await s.sync()
    expect(lines(s)).toEqual(['> one', '1', '> two again', '2b'])
    expect(s.epoch).not.toBe(epoch)
    expect(got).toContain('hello')
  })

  test('托管会话：SDK 流进了缓冲，回收子进程后对齐不重复；之后终端接着写照常补上', async () => {
    const t = new Transcript()
    const s = new Session(t.id, CWD, 't', () => {}, { fresh: true })
    s.send('one')
    await idle(s)
    const before = lines(s)
    expect(before).toEqual(['> one', 'system:init', 're: one', 'result:success'])
    const epoch = s.epoch
    s.sleep()
    await s.sync()
    expect(lines(s)).toEqual(before)
    expect(s.epoch).toBe(epoch)

    t.user('two')
    t.reply('2')
    await s.sync()
    expect(lines(s)).toEqual([...before, '> two', '2'])

    // 再从手机发：resume 接着写，回收后对齐照样不重复
    s.send('three')
    await idle(s)
    s.sleep()
    const n = s.lastSeq
    await s.sync()
    expect(s.lastSeq).toBe(n)
    expect(s.epoch).toBe(epoch)
  })
})

describe('关掉会话', () => {
  test('停子进程、出标签条，看着的收到 state；再发消息又回到标签条', async () => {
    const s = open(new Transcript())
    s.send('one')
    await idle(s)
    expect(s.live && s.listed).toBe(true)
    const got = watch(s)
    s.dismiss()
    expect(s.live).toBe(false)
    expect(s.listed).toBe(false)
    expect(got).toEqual(['state'])
    s.send('two')
    await idle(s)
    expect(lines(s).slice(-4)).toEqual(['> two', 'system:init', 're: two', 'result:success'])
    expect(s.listed).toBe(true)
  })
})
