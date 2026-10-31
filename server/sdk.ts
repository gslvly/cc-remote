// /api/sdk：查 npm 上最新的 SDK，在手机上升级。
// 升级时本机 claude 也换成与新 SDK 配套的那版（claude install <版本>，与 SDK manifest 里的是同一个文件），
// 终端里用的和子进程用的就是同一个。本机的比配套的还新时不降级，子进程先用 SDK 自带的（见 claudeBin.ts）
import { join } from 'node:path'
import { $ } from 'bun'
import { Hono } from 'hono'
import type { LocalClaudeInfo, SdkJob, SdkStatus, SdkVersion } from '../shared/protocol'
import { childEnv } from './child'
import { installedSdk, localClaude } from './claudeBin'
import { pruneOld } from './prune'

const PKG = '@anthropic-ai/claude-agent-sdk'
const ROOT = join(import.meta.dir, '..')
/** npm 上的最新版缓存多久；没查到时一分钟后再试 */
const LATEST_TTL = 30 * 60_000
const RETRY = 60_000
/** 落后满这么久才在首页顶上醒目提示；没到时只在底部放一行小字（npm 上差不多天天发版） */
export const STALE = 7 * 86_400_000

export const BUSY = '有会话正在跑（运行中 / 待批准），重启会打断它们，等它们空闲再升级'

/** 退出后有人拉起：systemd 给服务设 INVOCATION_ID；launchd 拉起的进程父进程是 1（README「开机自启」里配的是挂了就拉起） */
const supervised = !!process.env.INVOCATION_ID || (process.platform === 'darwin' && process.ppid === 1)

/** 输出的最后几行，报错用 */
const tail = (s: string) => s.trim().split('\n').slice(-8).join('\n')

/** npm 上发过的一版（不含预发布）；time 是发布时间 */
export interface Release extends SdkVersion {
  time: number
}

export interface Npm {
  latest: SdkVersion
  releases: Release[]
}

/** 要发布时间，只能取完整的包信息（~1MB，缓存半小时）。sdk-sync 也用它找配套的版本 */
export async function fetchNpm(): Promise<Npm | undefined> {
  try {
    const res = await fetch(`https://registry.npmjs.org/${PKG}`, { signal: AbortSignal.timeout(15_000) })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const m = (await res.json()) as {
      'dist-tags': { latest: string }
      versions: Record<string, { claudeCodeVersion?: string }>
      time: Record<string, string>
    }
    const version = m['dist-tags'].latest
    const releases = Object.entries(m.versions).flatMap(([v, p]) =>
      !v.includes('-') && p.claudeCodeVersion && m.time[v] ? [{ version: v, cli: p.claudeCodeVersion, time: Date.parse(m.time[v]) }] : [],
    )
    return { latest: { version, cli: m.versions[version]?.claudeCodeVersion ?? '?' }, releases }
  } catch (e) {
    console.warn(`[sdk] 查 npm 上的最新版失败：${e}`)
  }
}

/**
 * 该在首页顶上醒目提示了：有大版本（SDK 出了 ^在跑的 的范围，0.x 时就是 minor 变了；配套 claude 的 x.y 变了），
 * 或落后满 STALE（比在用的新的版本里最早的那版发布满 STALE）。SDK 和本机 claude 各看各的
 */
export function urgent(npm: Npm, running: SdkVersion, local: LocalClaudeInfo | undefined, now = Date.now()): boolean {
  const { latest, releases } = npm
  const stale = (newer: (r: Release) => boolean) => releases.some((r) => newer(r) && now - r.time >= STALE)
  const major = (from: string, to: string, range: '^' | '~') => !Bun.semver.satisfies(to, `${range}${from}`)

  const sdk = running.version
  if (Bun.semver.order(latest.version, sdk) > 0) {
    if (major(sdk, latest.version, '^') || major(running.cli, latest.cli, '~')) return true
    if (stale((r) => Bun.semver.order(r.version, sdk) > 0)) return true
  }
  const cli = local?.version
  if (cli && !local.matched && Bun.semver.order(latest.cli, cli) > 0) {
    if (major(cli, latest.cli, '~')) return true
    if (stale((r) => Bun.semver.order(r.cli, cli) > 0)) return true
  }
  return false
}

/** 失败时返回原因 */
async function exec(cmd: string[]): Promise<string | undefined> {
  const r = await $`${cmd}`.cwd(ROOT).env(childEnv()).nothrow().quiet()
  if (r.exitCode !== 0) return tail(`${r.stdout}\n${r.stderr}`)
}

/** 本机的比 cli 旧（版本读不出来也当旧的，装一次配套的） */
const older = (local: LocalClaudeInfo, cli: string) => !local.version || Bun.semver.order(local.version, cli) < 0

export interface SdkDeps {
  /** 现查 npm 上最新的和发过的各版 */
  npm: () => Promise<Npm | undefined>
  /** node_modules 里装着的版本 */
  installed: () => string
  /** 在跑的 */
  running: SdkVersion
  local: () => Promise<LocalClaudeInfo | undefined>
  /** 本机 claude 与 node_modules 里装着的 SDK 配套 */
  paired: () => boolean
  install: (version: string) => Promise<string | undefined>
  typecheck: () => Promise<string | undefined>
  /** 本机 claude 换成指定版本 */
  installClaude: (version: string) => Promise<string | undefined>
  /** 删旧版 claude 和缓存里的旧 SDK，留下 sdk 这版 */
  prune: (sdk: string) => Promise<string | undefined>
  supervised: boolean
}

const defaults: SdkDeps = {
  npm: fetchNpm,
  installed: () => installedSdk().version,
  running: { version: localClaude.sdk.version, cli: localClaude.sdk.cli },
  local: () => localClaude.local(),
  paired: () => localClaude.pairs(installedSdk()),
  install: (version) => exec([process.execPath, 'add', `${PKG}@${version}`, '--exact']),
  typecheck: () => exec([process.execPath, 'run', 'typecheck']),
  installClaude: (version) => exec([localClaude.file!, 'install', version]),
  prune: (sdk) => pruneOld(localClaude.file, sdk, ROOT),
  supervised,
}

/** 启动时也删一次：升级时还有会话在用的旧版 claude，重启后就没人用了 */
export function pruneOnStart() {
  defaults.prune(defaults.installed()).then(
    (said) => said && console.log(`[sdk] ${said}`),
    (e) => console.warn(`[sdk] 旧版没删掉：${e}`),
  )
}

/** busy：有托管会话在跑；restart：退出进程等服务管理器拉起 */
export function sdkRoutes(busy: () => boolean, restart: () => void, deps: Partial<SdkDeps> = {}) {
  const d = { ...defaults, ...deps }
  const sdk = new Hono()

  let cached: { until: number; value: Promise<Npm | undefined> } | undefined
  const npm = (fresh = false) => {
    if (fresh || !cached || Date.now() > cached.until) {
      const entry = { until: Date.now() + LATEST_TTL, value: d.npm() }
      void entry.value.then((v) => {
        if (!v) entry.until = Date.now() + RETRY
      })
      cached = entry
    }
    return cached.value
  }

  let job: SdkJob | undefined
  let starting = false
  const working = () => starting || job?.state === 'running' || job?.state === 'restarting'

  /** 装一版：SDK（类型检查没过就装回去再抛错），再把本机 claude 换成配套的（没换成只记下） */
  async function installOne(target: SdkVersion, step: (s: string) => void, note: (s: string) => void) {
    const before = d.installed()
    if (before !== target.version) {
      step(`装 SDK ${target.version}`)
      const failed = await d.install(target.version)
      if (failed) throw new Error(`装 SDK ${target.version} 失败：\n${failed}`)
      // 新 SDK 的类型对不上（接口改了）就装回去，免得重启后起不来
      step('类型检查')
      const broken = await d.typecheck()
      if (broken) {
        step(`装回 SDK ${before}`)
        const back = await d.install(before)
        throw new Error(`SDK ${target.version} 类型检查没过${back ? `，装回 ${before} 也失败了：\n${back}` : `，已装回 ${before}`}\n${broken}`)
      }
    }

    const local = await d.local()
    if (local && !d.paired()) {
      if (local.version === target.cli) note(`本机 claude 也是 ${target.cli}，但与 SDK 配套的不是同一个文件（不是原生安装？），子进程先用 SDK 自带的`)
      else if (!older(local, target.cli)) note(`本机 claude ${local.version} 比 SDK 配套的 ${target.cli} 新，不降级；子进程先用 SDK 自带的`)
      else {
        step(`本机 claude 换成 ${target.cli}`)
        const failed = await d.installClaude(target.cli)
        if (failed) note(`本机 claude 没换成 ${target.cli}，子进程先用 SDK 自带的：\n${failed}`)
        else if (!d.paired()) note(`装了 claude ${target.cli}，但 ${local.path} 与 SDK 配套的不是同一个文件（不是原生安装？），子进程先用 SDK 自带的`)
      }
    }
  }

  async function upgrade(j: SdkJob) {
    const step = (s: string) => {
      j.step = s
      console.log(`[sdk] ${s}`)
    }
    // 也打到日志里：页面上的 job 重启后就没了
    const note = (s: string) => {
      j.notes.push(s)
      console.warn(`[sdk] ${s}`)
    }

    // 网慢时装一版要一个多小时，装完 npm 上又出了新版就接着装，装到最新再重启
    for (let prev: SdkVersion | undefined; ; ) {
      try {
        await installOne(j.target, step, note)
      } catch (e) {
        // 后面几轮没装上、已经装回前一版的，就用前一版
        if (!prev || d.installed() !== prev.version) throw e
        note(`${e instanceof Error ? e.message : e}\n先用 SDK ${prev.version}`)
        j.target = prev
        break
      }
      const latest = (await npm(true))?.latest
      if (!latest || Bun.semver.order(latest.version, j.target.version) <= 0) break
      note(`装的时候 npm 上又出了 SDK ${latest.version}，接着装`)
      prev = j.target
      j.target = latest
    }
    const { target } = j

    // 删不掉不影响升级，记下来
    step('删旧版')
    try {
      const said = await d.prune(target.version)
      if (said) console.log(`[sdk] ${said}`)
    } catch (e) {
      j.notes.push(`旧版没删掉：${e instanceof Error ? e.message : e}`)
    }

    // 只换了 claude：下次起子进程时就核对到新文件，不用重启
    if (target.version === d.running.version) j.state = 'done'
    else if (!d.supervised) {
      j.notes.push('服务端不是 launchd / systemd 拉起的，到电脑上重启后新 SDK 才生效')
      j.state = 'done'
    } else if (busy()) {
      j.notes.push('装的时候有会话开始跑，没重启；等它们空闲再点「重启生效」')
      j.state = 'done'
    } else {
      step('重启服务端')
      j.state = 'restarting'
      setTimeout(restart, 300)
    }
  }

  // ?fresh：首页的「检查更新」，不用缓存
  sdk.get('/', async (c) => {
    const n = await npm(c.req.query('fresh') !== undefined)
    const local = await d.local()
    return c.json<SdkStatus>({
      running: d.running,
      installed: d.installed(),
      latest: n?.latest,
      local,
      restartable: d.supervised,
      urge: !!n && urgent(n, d.running, local),
      job,
    })
  })

  // 装了还没重启（没人拉起、当时有会话在跑）时再点：跳过装，只重启
  sdk.post('/upgrade', async (c) => {
    if (working()) return c.json({ error: '正在升级' }, 409)
    starting = true
    try {
      const target = (await npm(true))?.latest
      if (!target) return c.json({ error: '查不到 npm 上的最新版，看服务端能不能连上 registry.npmjs.org' }, 502)
      const sdkChanges = target.version !== d.running.version
      const local = await d.local()
      if (!sdkChanges && !(local && !local.matched && older(local, target.cli))) return c.json({ error: `已经是最新的 SDK ${target.version}` }, 409)
      if (sdkChanges && busy()) return c.json({ error: BUSY }, 409)

      const j: SdkJob = { target, step: '开始', state: 'running', notes: [] }
      job = j
      void upgrade(j).catch((e) => {
        j.state = 'failed'
        j.error = e instanceof Error ? e.message : String(e)
        console.warn(`[sdk] 升级失败：${j.error}`)
      })
      return c.json<SdkJob>(j, 202)
    } finally {
      starting = false
    }
  })

  return sdk
}
