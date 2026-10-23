// 终端会话登记表：排除服务端自己起的子进程、残留的登记
import { CWD } from './testkit'
import { describe, expect, test } from 'bun:test'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
const { CLAUDE_DIR } = await import('./config')
const { scanHolders } = await import('./terminal')

const DIR = join(CLAUDE_DIR, 'sessions')
const A = crypto.randomUUID()
const B = crypto.randomUUID()

/** 登记表文件名就是 pid，用两个活着的 pid：自己和父进程 */
function register(records: object[]) {
  rmSync(DIR, { recursive: true, force: true })
  mkdirSync(DIR, { recursive: true })
  for (const r of records as { pid: number }[]) writeFileSync(join(DIR, `${r.pid}.json`), JSON.stringify({ cwd: CWD, kind: 'interactive', ...r }))
}

describe('scanHolders', () => {
  test('sdk-ts 且会话在服务端里的是自己的子进程，不算；终端里的 cli 算', async () => {
    register([
      { pid: process.pid, sessionId: A, entrypoint: 'sdk-ts' },
      { pid: process.ppid, sessionId: B, entrypoint: 'cli', status: 'busy' },
    ])
    const holders = await scanHolders((id) => id === A)
    expect([...holders.keys()]).toEqual([B])
    expect(holders.get(B)).toMatchObject({ pid: process.ppid, cwd: CWD, status: 'busy' })
    // 别的 SDK 程序开的会话（不在服务端里）照样算
    expect([...(await scanHolders(() => false)).keys()].sort()).toEqual([A, B].sort())
  })

  test('进程没了、启动时间对不上的残留登记不算', async () => {
    register([
      { pid: 999_999, sessionId: A, entrypoint: 'cli' },
      { pid: process.ppid, sessionId: B, entrypoint: 'cli', procStart: 'Thu Jan  1 00:00:00 1970' },
    ])
    expect((await scanHolders(() => false)).size).toBe(0)
  })

  test.if(process.platform === 'linux')('Linux 上新版登记的是 /proc 里的 starttime：对得上的算，对不上的不算；带上在等什么', async () => {
    // 父进程是 bun，进程名没有空格，直接按空格切
    const start = readFileSync(`/proc/${process.ppid}/stat`, 'utf8').split(' ')[21]
    register([
      { pid: process.ppid, sessionId: B, entrypoint: 'cli', procStart: start, status: 'waiting', waitingFor: 'permission prompt' },
      { pid: process.pid, sessionId: A, entrypoint: 'cli', procStart: '1' },
    ])
    const holders = await scanHolders(() => false)
    expect([...holders.keys()]).toEqual([B])
    expect(holders.get(B)).toMatchObject({ status: 'waiting', waitingFor: 'permission prompt' })
  })
})
