// 接管终端里的会话：关掉终端里的 claude（拿一个假进程当它），模型、effort 照它的启动参数，之后照常 resume
import { CWD, idle, lines, spawned, Transcript } from './testkit'
import { afterAll, describe, expect, test } from 'bun:test'
import { mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
const { CLAUDE_DIR } = await import('./config')
const { SessionManager } = await import('./manager')
const { ConflictError } = await import('./session')
const { alive, launchFlags, parseFlags, terminate } = await import('./terminal')

mkdirSync(CWD, { recursive: true })
const DIR = join(CLAUDE_DIR, 'sessions')
mkdirSync(DIR, { recursive: true })
afterAll(() => rmSync(CWD, { recursive: true, force: true }))

/** 假的终端 claude：命令行带着 args，收到 SIGTERM 就退（ignoreTerm 的不理，只能 SIGKILL） */
function fakeClaude(args: string[], ignoreTerm = false) {
  const trap = ignoreTerm ? "trap '' TERM" : "trap 'exit 0' TERM"
  return Bun.spawn(['bash', '-c', `${trap}; while :; do sleep 0.05; done`, 'claude', ...args])
}

describe('终端 claude 的启动参数', () => {
  test('--model、--effort 两种写法，给了几次取最后一次；effort 不认识的、没给的不算', () => {
    expect(parseFlags(['claude', '--model', 'opus', '--effort=high'])).toEqual({ model: 'opus', effort: 'high' })
    expect(parseFlags(['claude', '--model=haiku', '-c', '--model', 'sonnet[1m]'])).toEqual({ model: 'sonnet[1m]', effort: undefined })
    expect(parseFlags(['claude', '--effort', 'turbo'])).toEqual({ model: undefined, effort: undefined })
    expect(parseFlags(['claude', '--model'])).toEqual({ model: undefined, effort: undefined })
  })

  test('从活着的进程上读', async () => {
    const p = fakeClaude(['--resume', 'x', '--model', 'sonnet', '--effort', 'max'])
    await Bun.sleep(50)
    expect(await launchFlags(p.pid)).toEqual({ model: 'sonnet', effort: 'max' })
    p.kill()
  })
})

describe('关掉终端里的 claude', () => {
  test('SIGTERM 就退的', async () => {
    const p = fakeClaude([])
    await Bun.sleep(50)
    expect(await terminate(p.pid)).toBe(true)
    expect(alive(p.pid)).toBe(false)
  })

  test('不理 SIGTERM 的，等一会儿 SIGKILL', async () => {
    const p = fakeClaude([], true)
    await Bun.sleep(50)
    expect(await terminate(p.pid, 200)).toBe(true)
    expect(p.signalCode).toBe('SIGKILL')
  })

  test('已经没了的', async () => {
    const p = fakeClaude([])
    p.kill('SIGKILL')
    await p.exited
    expect(await terminate(p.pid)).toBe(true)
  })
})

describe('接管', () => {
  const manager = () => new SessionManager({ maxLive: 3, idleMinutes: 10, roots: [realpathSync(CWD)] })

  /** 一个终端开着的会话：登记表里记着假进程 */
  async function held(status: string, args: string[] = []) {
    const t = new Transcript()
    t.user('one')
    t.reply('1')
    const p = fakeClaude(args)
    await Bun.sleep(50)
    writeFileSync(join(DIR, `${p.pid}.json`), JSON.stringify({ pid: p.pid, sessionId: t.id, cwd: CWD, kind: 'interactive', entrypoint: 'cli', status }))
    const m = manager()
    const s = (await m.open(t.id))!
    await m.scan()
    return { t, p, m, s }
  }

  test('不带 takeover 的照旧不让发；终端正在跑的只有「打断并接管」能接', async () => {
    const { p, m, s } = await held('busy')
    expect(s.terminal).toBe('running')
    await expect(m.send(s, 'hi')).rejects.toThrow(ConflictError)
    await expect(m.send(s, 'hi', undefined, true)).rejects.toThrow('终端里正在跑')
    expect(alive(p.pid)).toBe(true)
    await m.takeover(s, true)
    expect(alive(p.pid)).toBe(false)
    expect(s.terminal).toBeUndefined()
    m.closeAll()
  })

  test('空闲的：发消息时关掉终端，resume 接着聊，模型、effort 照终端的启动参数', async () => {
    const { t, p, m, s } = await held('idle', ['--model', 'sonnet', '--effort', 'high'])
    await m.send(s, 'hi', undefined, true)
    expect(alive(p.pid)).toBe(false)
    await idle(s)
    expect(lines(s)).toEqual(['> one', '1', '> hi', 'system:init', 're: hi', 'result:success'])
    expect(spawned.at(-1)?.options).toMatchObject({ resume: t.id, model: 'sonnet', effort: 'high' })
    m.closeAll()
  })

  test('终端没给 --model：以前在手机上选的不带过去，由配置定（同终端）', async () => {
    const { m, s } = await held('idle')
    // 当作以前在手机上选过
    s.inherit({ model: 'haiku' })
    await m.send(s, 'hi', undefined, true)
    await idle(s)
    expect(spawned.at(-1)?.options.model).toBeUndefined()
    m.closeAll()
  })
})
