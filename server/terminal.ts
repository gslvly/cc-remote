// 终端里正在跑的会话：读 Claude Code 的运行中会话登记表 ~/.claude/sessions/<pid>.json。
// 判断「进程还在」照抄 Claude Code 自己的做法：pid 活着，并且启动时间与登记的 procStart 一致（残留的登记可能撞上被复用的 pid）。
// procStart 是 macOS / Linux 上 ps 的 lstart；Windows 上 Claude Code 登记的是 procStartFt（FILETIME），不比对，只看 pid 活着。
// 同目录的 <pid>.<hash>.key 是密钥，只读 <pid>.json
import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { CLAUDE_DIR } from './config'

const DIR = join(CLAUDE_DIR, 'sessions')
/** daemon / daemon-worker 是 Claude Code 内部的进程，不算 */
const KINDS = ['interactive', 'bg']

/** 持有某个会话的终端进程 */
export interface Holder {
  pid: number
  sessionId: string
  cwd: string
  /** busy | shell | idle | waiting */
  status?: string
  updatedAt: number
}

interface Record {
  pid: number
  sessionId: string
  cwd: string
  kind?: string
  entrypoint?: string
  status?: string
  procStart?: string
  parkedJobId?: string
  updatedAt?: number
  statusUpdatedAt?: number
}

const valid = (r: Partial<Record> | undefined): r is Record =>
  typeof r?.pid === 'number' && typeof r.sessionId === 'string' && typeof r.cwd === 'string'

function alive(pid: number) {
  try {
    process.kill(pid, 0)
    return true
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM'
  }
}

/** pid → 启动时间。pid 活着就一直有效，查过的不再查 */
const procs = new Map<number, string>()

/** 一次 ps 查多个进程。lstart 在 LC_ALL=C TZ=UTC 下的格式与 procStart 相同（Claude Code 也是这么取的）；有 pid 查不到时 ps 退出码非 0，但查到的照样输出 */
async function lookup(pids: number[]) {
  if (!pids.length) return
  try {
    const ps = Bun.spawn(['ps', '-o', 'pid=,lstart=', '-p', pids.join(',')], {
      env: { ...process.env, LC_ALL: 'C', TZ: 'UTC' },
      stdout: 'pipe',
      stderr: 'ignore',
    })
    for (const line of (await new Response(ps.stdout).text()).split('\n')) {
      const m = line.match(/^\s*(\d+)\s+(.+?)\s*$/)
      if (m) procs.set(Number(m[1]), m[2]!)
    }
  } catch (e) {
    console.warn('[terminal] ps 失败', e)
  }
}

/**
 * sessionId → 持有它的终端进程。服务端自己起的 claude 子进程也会登记（entrypoint 为 sdk-ts），
 * 按「sdk-ts 且会话在服务端里」排除（ours）；终端里 resume 同一个会话的进程是 cli，不受影响
 */
export async function scanHolders(ours: (sessionId: string) => boolean): Promise<Map<string, Holder>> {
  const names = await readdir(DIR).catch(() => [] as string[])
  const records = await Promise.all(
    names
      .filter((n) => /^\d+\.json$/.test(n))
      .map((n) =>
        readFile(join(DIR, n), 'utf8').then(
          (s) => JSON.parse(s) as Partial<Record>,
          () => undefined,
        ),
      ),
  )
  const live = records
    .filter(valid)
    .filter((r) => KINDS.includes(r.kind ?? 'interactive') && !r.parkedJobId && !(r.entrypoint === 'sdk-ts' && ours(r.sessionId)) && alive(r.pid))

  const pids = new Set(live.map((r) => r.pid))
  for (const pid of procs.keys()) if (!pids.has(pid)) procs.delete(pid)
  await lookup(live.filter((r) => r.procStart && procs.get(r.pid) !== r.procStart).map((r) => r.pid))

  const out = new Map<string, Holder>()
  for (const r of live) {
    // 没有 procStart（老版本、Windows）只能信 pid
    if (r.procStart && procs.get(r.pid) !== r.procStart) continue
    const updatedAt = r.statusUpdatedAt ?? r.updatedAt ?? 0
    const prev = out.get(r.sessionId)
    // 同一个会话被多个进程持有时，取状态最新的那个
    if (prev && prev.updatedAt >= updatedAt) continue
    out.set(r.sessionId, { pid: r.pid, sessionId: r.sessionId, cwd: r.cwd, status: r.status, updatedAt })
  }
  return out
}
