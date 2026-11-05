// 终端里正在跑的会话：读 Claude Code 的运行中会话登记表 ~/.claude/sessions/<pid>.json；手机上接管时关掉持有它的进程。
// 判断「进程还在」照抄 Claude Code 自己的做法：pid 活着，并且启动时间与登记的 procStart 一致（残留的登记可能撞上被复用的 pid）。
// procStart 在 macOS 上是 ps 的 lstart；Linux 上新版（实测 2.1.307）是 /proc/<pid>/stat 的 starttime（纯数字），按格式分别比对。
// Windows 上 Claude Code 登记的是 procStartFt（FILETIME），不比对，只看 pid 活着。
// 同目录的 <pid>.<hash>.key 是密钥，只读 <pid>.json
import type { EffortLevel } from '@anthropic-ai/claude-agent-sdk'
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
  /** waiting 时在等什么。实测（2.1.307）工具审批是 permission prompt；还有 dialog open（终端里自己打开的 /config 之类）、input needed、sandbox request */
  waitingFor?: string
  updatedAt: number
}

interface Record {
  pid: number
  sessionId: string
  cwd: string
  kind?: string
  entrypoint?: string
  status?: string
  waitingFor?: string
  procStart?: string
  parkedJobId?: string
  updatedAt?: number
  statusUpdatedAt?: number
}

const valid = (r: Partial<Record> | undefined): r is Record =>
  typeof r?.pid === 'number' && typeof r.sessionId === 'string' && typeof r.cwd === 'string'

export function alive(pid: number) {
  try {
    process.kill(pid, 0)
    return true
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM'
  }
}

/** 终端里的 claude 启动时给的 --model、--effort。接管后子进程照着起：模型、effort 一变，缓存就从头写。没给的由配置定，两边读的是同一份 */
export interface LaunchFlags {
  model?: string
  effort?: EffortLevel
}

const EFFORTS = new Set<unknown>(['low', 'medium', 'high', 'xhigh', 'max'] satisfies EffortLevel[])

/** 同 CLI：给了几次的取最后一次，--model x 与 --model=x 两种写法 */
export function parseFlags(argv: string[]): LaunchFlags {
  const get = (name: string) => {
    let v: string | undefined
    argv.forEach((a, i) => {
      if (a === name) v = argv[i + 1]
      else if (a.startsWith(`${name}=`)) v = a.slice(name.length + 1)
    })
    return v
  }
  const effort = get('--effort')
  return { model: get('--model') || undefined, effort: EFFORTS.has(effort) ? (effort as EffortLevel) : undefined }
}

/** Linux 读 /proc/<pid>/cmdline（\0 分隔，原样）；别的按 ps 的输出用空格切（模型名、effort 里没有空格）。读不到（Windows）当作没给 */
export async function launchFlags(pid: number): Promise<LaunchFlags> {
  try {
    const raw = await readFile(`/proc/${pid}/cmdline`, 'utf8').catch(async () => {
      const ps = Bun.spawn(['ps', '-o', 'args=', '-p', String(pid)], { stdout: 'pipe', stderr: 'ignore' })
      return (await new Response(ps.stdout).text()).trim().replace(/\s+/g, '\0')
    })
    return parseFlags(raw.split('\0'))
  } catch {
    return {}
  }
}

/**
 * 关掉终端里的 claude：先 SIGTERM，它自己收尾（复原终端设置；transcript 是逐条写的，不丢），过 ms 还在再 SIGKILL。
 * Windows 上 process.kill 本来就是直接结束。返回关没关掉
 */
export async function terminate(pid: number, ms = 5000): Promise<boolean> {
  const gone = async (ms: number) => {
    for (const end = Date.now() + ms; alive(pid); await Bun.sleep(50)) if (Date.now() > end) return false
    return true
  }
  for (const [sig, wait] of [['SIGTERM', ms], ['SIGKILL', 2000]] as const) {
    try {
      process.kill(pid, sig)
    } catch {
      // 已经没了，或不是自己的进程（EPERM）
      return !alive(pid)
    }
    if (await gone(wait)) return true
  }
  return false
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

/** Linux 的 starttime：/proc/<pid>/stat 第 22 项（开机后的时钟 tick）。进程名在括号里、可能带空格，从最后一个右括号后面数，那里是第 3 项 */
async function lookupStat(pids: number[]) {
  await Promise.all(
    pids.map(async (pid) => {
      const stat = await readFile(`/proc/${pid}/stat`, 'utf8').catch(() => '')
      const t = stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19]
      if (t) procs.set(pid, t)
    }),
  )
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
  const stale = live.filter((r) => r.procStart && procs.get(r.pid) !== r.procStart)
  const tick = (r: Record) => /^\d+$/.test(r.procStart!)
  await Promise.all([lookupStat(stale.filter(tick).map((r) => r.pid)), lookup(stale.filter((r) => !tick(r)).map((r) => r.pid))])

  const out = new Map<string, Holder>()
  for (const r of live) {
    // 没有 procStart（老版本、Windows）只能信 pid
    if (r.procStart && procs.get(r.pid) !== r.procStart) continue
    const updatedAt = r.statusUpdatedAt ?? r.updatedAt ?? 0
    const prev = out.get(r.sessionId)
    // 同一个会话被多个进程持有时，取状态最新的那个
    if (prev && prev.updatedAt >= updatedAt) continue
    out.set(r.sessionId, { pid: r.pid, sessionId: r.sessionId, cwd: r.cwd, status: r.status, waitingFor: r.waitingFor, updatedAt })
  }
  return out
}
