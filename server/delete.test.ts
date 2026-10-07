// 删会话：transcript、子代理目录、CLI 按 id 建的目录都删掉；托管的先停子进程、通知看着的手机；终端里开着的不删
import { CWD, idle, Transcript, watch } from './testkit'
import { afterAll, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { getSessionInfo } from '@anthropic-ai/claude-agent-sdk'
const { CLAUDE_DIR } = await import('./config')
const { SessionManager } = await import('./manager')
const { ConflictError } = await import('./session')

// cwd 要在 roots 内（真实路径）才算存在
mkdirSync(CWD, { recursive: true })
afterAll(() => rmSync(CWD, { recursive: true, force: true }))
const manager = () => new SessionManager({ maxLive: 3, idleMinutes: 10, roots: [realpathSync(CWD)] })

/** CLI 按会话 id 建的：子代理 transcript 目录、文件快照、会话环境 */
function sidecars(id: string) {
  const dirs = [join(CLAUDE_DIR, 'projects', CWD.replace(/[^a-zA-Z0-9]/g, '-'), id, 'subagents'), join(CLAUDE_DIR, 'file-history', id), join(CLAUDE_DIR, 'session-env', id)]
  for (const d of dirs) mkdirSync(d, { recursive: true })
  writeFileSync(join(dirs[1]!, 'a@v1'), 'x')
  return dirs
}

describe('删会话', () => {
  test('历史会话：transcript 和按 id 建的目录都删掉，之后打不开', async () => {
    const m = manager()
    const t = new Transcript()
    t.user('one')
    t.reply('1')
    const dirs = sidecars(t.id)
    expect(await m.remove(t.id)).toBe(true)
    expect(await getSessionInfo(t.id)).toBeUndefined()
    for (const d of dirs) expect(existsSync(d)).toBe(false)
    expect(await m.open(t.id)).toBeUndefined()
    m.closeAll()
  })

  test('没有的、不是 uuid 的：false', async () => {
    const m = manager()
    expect(await m.remove(crypto.randomUUID())).toBe(false)
    expect(await m.remove('../x')).toBe(false)
    m.closeAll()
  })

  test('托管的：停子进程、出概览、看着的手机收到 deleted；拿着旧引用再发消息报错', async () => {
    const m = manager()
    const s = await m.create(CWD, 'hi')
    await idle(s)
    expect(s.live).toBe(true)
    const got = watch(s)
    expect(await m.remove(s.id)).toBe(true)
    expect(s.live).toBe(false)
    expect(got.at(-1)).toBe('deleted')
    expect(m.list().some((x) => x.id === s.id)).toBe(false)
    expect(m.get(s.id)).toBeUndefined()
    await expect(m.send(s, 'again')).rejects.toBeInstanceOf(ConflictError)
    m.closeAll()
  })

  test('! 命令跑着的：直接停掉，不等', async () => {
    const m = manager()
    const s = await m.create(CWD, 'hi')
    await idle(s)
    await m.bash(s, 'sleep 5')
    expect(s.state).toBe('running')
    const t0 = Date.now()
    expect(await m.remove(s.id)).toBe(true)
    expect(Date.now() - t0).toBeLessThan(1000)
    m.closeAll()
  })

  test('终端里还开着的不删', async () => {
    const t = new Transcript()
    t.user('one')
    // 先登记再建 manager：建的时候就开始扫，删的时候等的是这一轮
    const dir = join(CLAUDE_DIR, 'sessions')
    mkdirSync(dir, { recursive: true })
    const reg = join(dir, `${process.pid}.json`)
    writeFileSync(reg, JSON.stringify({ pid: process.pid, sessionId: t.id, cwd: CWD, kind: 'interactive', entrypoint: 'cli' }))
    const m = manager()
    try {
      await expect(m.remove(t.id)).rejects.toBeInstanceOf(ConflictError)
      expect(await getSessionInfo(t.id)).toBeDefined()
    } finally {
      rmSync(reg)
      m.closeAll()
    }
  })
})
