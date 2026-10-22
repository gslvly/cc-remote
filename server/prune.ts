// 删旧版：本机 claude 原生安装留下的旧版本（每个 ~250MB），bun 缓存里旧版 SDK 的平台包（每版 ~500MB）。
// 升级完、sdk:sync 后、服务端启动时各删一次。只删认得出的、比在用的旧的：
// - claude 要是 …/versions/<版本号> 的原生安装；还有进程在跑的不删（它会按自己的路径再起自己，删了就坏），下次再删；
//   比在用的新的不删（claude 自己更新时先下好新版再切链接，别删到半路的）
// - bun 缓存只动 claude-agent-sdk 的条目；node_modules 里的是硬链接 / 拷贝，删缓存不影响装着的
import { readdirSync, readlinkSync, realpathSync, rmSync } from 'node:fs'
import { basename, dirname, join, sep } from 'node:path'
import { $ } from 'bun'

const VERSION = /^\d+\.\d+\.\d+$/
/** 缓存目录里的条目：claude-agent-sdk[-平台]@版本@…@@@n */
const SDK_ENTRY = /^claude-agent-sdk(?:-[\w-]+)?@([^@]+)@/

const older = (v: string, than: string) => Bun.semver.order(v, than) < 0

/** dir 下在跑的程序文件。Linux 读 /proc/<pid>/exe，别的系统用 lsof；查不了返回 undefined（就不删） */
export async function runningIn(dir: string): Promise<string[] | undefined> {
  if (process.platform === 'linux') {
    const exes: string[] = []
    for (const pid of readdirSync('/proc')) {
      if (!/^\d+$/.test(pid)) continue
      try {
        exes.push(readlinkSync(`/proc/${pid}/exe`))
      } catch {}
    }
    return exes
  }
  if (!Bun.which('lsof')) return
  const r = await $`lsof -nP -Fn -d txt +D ${dir}`.nothrow().quiet()
  // 一个都没打开也是退出码 1；报了错就当查不了
  if (r.exitCode !== 0 && (r.exitCode !== 1 || r.stderr.length)) return
  return r.stdout
    .toString()
    .split('\n')
    .filter((l) => l.startsWith('n'))
    .map((l) => l.slice(1))
}

export interface Pruned {
  removed: string[]
  /** 还有进程在跑、或删不掉的 */
  kept: string[]
}

/** bin 指向的那版之前的都删，running 里的留着 */
export function pruneClaudeVersions(bin: string, running: string[]): Pruned {
  const out: Pruned = { removed: [], kept: [] }
  const current = realpathSync(bin)
  const dir = dirname(current)
  if (basename(dir) !== 'versions' || !VERSION.test(basename(current))) return out
  const old = readdirSync(dir)
    .filter((name) => VERSION.test(name) && older(name, basename(current)))
    .sort(Bun.semver.order)
  for (const name of old) {
    const file = join(dir, name)
    if (running.some((p) => p === file || p.startsWith(file + sep))) {
      out.kept.push(name)
      continue
    }
    try {
      rmSync(file, { recursive: true, force: true })
      out.removed.push(name)
    } catch {
      out.kept.push(name)
    }
  }
  return out
}

/** 缓存里比 keep 旧的 SDK 都删，返回删了的条目 */
export function pruneSdkCache(cacheDir: string, keep: string): string[] {
  const dir = join(cacheDir, '@anthropic-ai')
  let names: string[]
  try {
    names = readdirSync(dir)
  } catch {
    return []
  }
  const removed: string[] = []
  for (const name of names) {
    const v = name.match(SDK_ENTRY)?.[1]
    if (!v || !older(v, keep)) continue
    try {
      rmSync(join(dir, name), { recursive: true, force: true })
      removed.push(name)
    } catch {}
  }
  return removed
}

/** 两样都删，返回给日志的一句；sdk 是装着的版本，cwd 要有 package.json（bun pm cache 要） */
export async function pruneOld(claudeBin: string | undefined, sdk: string, cwd: string): Promise<string | undefined> {
  const said: string[] = []
  if (claudeBin) {
    try {
      const dir = dirname(realpathSync(claudeBin))
      const running = basename(dir) === 'versions' ? await runningIn(dir) : []
      if (!running) said.push('查不了哪些 claude 在跑，旧版 claude 没删')
      else {
        const { removed, kept } = pruneClaudeVersions(claudeBin, running)
        if (removed.length) said.push(`删了旧版 claude ${removed.join('、')}`)
        if (kept.length) said.push(`claude ${kept.join('、')} 还有进程在跑，下次再删`)
      }
    } catch (e) {
      said.push(`旧版 claude 没删掉：${e}`)
    }
  }
  const cache = (await $`${process.execPath} pm cache`.cwd(cwd).quiet()).stdout.toString().trim()
  const entries = pruneSdkCache(cache, sdk)
  if (entries.length) said.push(`删了 bun 缓存里旧版 SDK ${entries.length} 个`)
  if (said.length) return said.join('；')
}
