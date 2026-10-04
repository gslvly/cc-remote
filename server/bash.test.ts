// ! 命令：跑命令本身（runShell），和会话里的记录、交给子进程、与 transcript 对齐（Session.bash）
import { idle, lines, spawned, Transcript } from './testkit'
import { describe, expect, test } from 'bun:test'
import { mkdtempSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const { Session, ConflictError } = await import('./session')
const { MAX_CHARS, runShell } = await import('./shell')

const DIR = realpathSync(mkdtempSync(join(tmpdir(), 'ccr-bash-')))
writeFileSync(join(DIR, 'hello.txt'), 'hi there\n')

const never = new AbortController().signal

describe('runShell', () => {
  test('在给的目录里跑；退出码非 0 记进 stderr', async () => {
    expect(await runShell('cat hello.txt', DIR, never)).toEqual({ stdout: 'hi there', stderr: '' })
    expect(await runShell('echo out; echo err >&2; exit 3', DIR, never)).toEqual({ stdout: 'out', stderr: 'err\nExit code 3' })
  })

  test('输出太长截掉', async () => {
    const { stdout } = await runShell(`head -c ${MAX_CHARS * 2} /dev/zero | tr '\\0' x`, DIR, never)
    expect(stdout).toBe(`${'x'.repeat(MAX_CHARS)}\n... [output truncated]`)
  })

  test('超时、中断时连它起的子进程一起停掉', async () => {
    const t0 = Date.now()
    const timedOut = await runShell('sleep 5 | cat; echo done', DIR, never, 200)
    expect(timedOut).toEqual({ stdout: '', stderr: 'Command timed out after 0.2s' })
    const ac = new AbortController()
    setTimeout(() => ac.abort(), 100)
    expect(await runShell('echo started; sleep 5; echo done', DIR, ac.signal)).toEqual({ stdout: 'started', stderr: 'Interrupted' })
    expect(Date.now() - t0).toBeLessThan(2000)
  })

  test('目录不在了：不抛错，原因记进 stderr', async () => {
    const out = await runShell('true', join(DIR, 'gone'), never)
    expect(out.stdout).toBe('')
    expect(out.stderr).not.toBe('')
  })
})

describe('Session.bash', () => {
  const open = (t: Transcript) => new Session(t.id, DIR, 't', () => {}, { fresh: false })
  /** 缓冲里看得见的（不含子进程每条回的 init） */
  const said = (s: InstanceType<typeof Session>) => lines(s).filter((l) => l !== 'system:init')

  test('命令和输出记进缓冲，交给子进程但不开始这一轮；回收后与 transcript 对得上', async () => {
    const t = new Transcript()
    t.user('one')
    t.reply('1')
    const s = open(t)
    await s.sync()
    const n = spawned.length
    s.bash('cat hello.txt; echo oops >&2')
    expect(s.state).toBe('running')
    await idle(s)
    await Bun.sleep(20)
    // 回执的 result 不进缓冲
    expect(lines(s)).toEqual(['> one', '1', '> ! cat hello.txt; echo oops >&2', 'note hi there⏎oops', 'system:init', 'system:init'])
    expect(spawned.length).toBe(n + 1)
    expect(s.owned).toBe(true)
    const epoch = s.epoch
    s.sleep()
    await s.sync()
    expect(s.epoch).toBe(epoch)
    s.send('two')
    await idle(s)
    expect(lines(s).slice(6)).toEqual(['> two', 'system:init', 're: two', 'result:success'])
  })

  test('没有输出：缓冲里只有命令，transcript 里的输出那条也记住了', async () => {
    const t = new Transcript()
    t.user('one')
    t.reply('1')
    const s = open(t)
    await s.sync()
    s.bash('true')
    await idle(s)
    expect(said(s)).toEqual(['> one', '1', '> ! true'])
    const epoch = s.epoch
    s.sleep()
    await s.sync()
    expect(s.epoch).toBe(epoch)
  })

  test('跑的时候不能发消息、不能再跑；中断就停掉命令，照样记', async () => {
    const t = new Transcript()
    t.user('one')
    t.reply('1')
    const s = open(t)
    await s.sync()
    s.bash('echo started; sleep 5')
    expect(() => s.send('two')).toThrow(ConflictError)
    expect(() => s.bash('true')).toThrow(ConflictError)
    await Bun.sleep(100)
    await s.interrupt()
    await idle(s)
    expect(said(s).slice(2)).toEqual(['> ! echo started; sleep 5', 'note started⏎Interrupted'])
  })
})
