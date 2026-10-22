// /api/sdk：查 npm 上最新的 SDK，在手机上升级。
// 升级时本机 claude 也换成与新 SDK 配套的那版（claude install <版本>，与 SDK manifest 里的是同一个文件），
// 终端里用的和子进程用的就是同一个。本机的比配套的还新时不降级，子进程先用 SDK 自带的（见 claudeBin.ts）
import { join } from 'node:path'
import { $ } from 'bun'
import { Hono } from 'hono'
import type { LocalClaudeInfo, SdkJob, SdkStatus, SdkVersion } from '../shared/protocol'
import { childEnv } from './child'
import { installedSdk, localClaude } from './claudeBin'

const PKG = '@anthropic-ai/claude-agent-sdk'
const ROOT = join(import.meta.dir, '..')
/** npm 上的最新版缓存多久；没查到时一分钟后再试 */
const LATEST_TTL = 30 * 60_000
const RETRY = 60_000

export const BUSY = '有会话正在跑（运行中 / 待批准），重启会打断它们，等它们空闲再升级'

/** 退出后有人拉起：systemd 给服务设 INVOCATION_ID；launchd 拉起的进程父进程是 1（README「开机自启」里配的是挂了就拉起） */
const supervised = !!process.env.INVOCATION_ID || (process.platform === 'darwin' && process.ppid === 1)

/** 输出的最后几行，报错用 */
const tail = (s: string) => s.trim().split('\n').slice(-8).join('\n')

async function fetchLatest(): Promise<SdkVersion | undefined> {
  try {
    const res = await fetch(`https://registry.npmjs.org/${PKG}/latest`, { signal: AbortSignal.timeout(15_000) })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const m = (await res.json()) as { version: string; claudeCodeVersion?: string }
    return { version: m.version, cli: m.claudeCodeVersion ?? '?' }
  } catch (e) {
    console.warn(`[sdk] 查 npm 上的最新版失败：${e}`)
  }
}

/** 失败时返回原因 */
async function exec(cmd: string[]): Promise<string | undefined> {
  const r = await $`${cmd}`.cwd(ROOT).env(childEnv()).nothrow().quiet()
  if (r.exitCode !== 0) return tail(`${r.stdout}\n${r.stderr}`)
}

/** 本机的比 cli 旧（版本读不出来也当旧的，装一次配套的） */
const older = (local: LocalClaudeInfo, cli: string) => !local.version || Bun.semver.order(local.version, cli) < 0

export interface SdkDeps {
  /** 现查 npm 上最新的 */
  latest: () => Promise<SdkVersion | undefined>
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
  supervised: boolean
}

const defaults: SdkDeps = {
  latest: fetchLatest,
  installed: () => installedSdk().version,
  running: { version: localClaude.sdk.version, cli: localClaude.sdk.cli },
  local: () => localClaude.local(),
  paired: () => localClaude.pairs(installedSdk()),
  install: (version) => exec([process.execPath, 'add', `${PKG}@${version}`, '--exact']),
  typecheck: () => exec([process.execPath, 'run', 'typecheck']),
  installClaude: (version) => exec([localClaude.file!, 'install', version]),
  supervised,
}

/** busy：有托管会话在跑；restart：退出进程等服务管理器拉起 */
export function sdkRoutes(busy: () => boolean, restart: () => void, deps: Partial<SdkDeps> = {}) {
  const d = { ...defaults, ...deps }
  const sdk = new Hono()

  let cached: { until: number; value: Promise<SdkVersion | undefined> } | undefined
  const latest = (fresh = false) => {
    if (fresh || !cached || Date.now() > cached.until) {
      const entry = { until: Date.now() + LATEST_TTL, value: d.latest() }
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

  async function upgrade(j: SdkJob) {
    const { target } = j
    const step = (s: string) => {
      j.step = s
      console.log(`[sdk] ${s}`)
    }

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
      if (local.version === target.cli) j.notes.push(`本机 claude 也是 ${target.cli}，但与 SDK 配套的不是同一个文件（不是原生安装？），子进程先用 SDK 自带的`)
      else if (!older(local, target.cli)) j.notes.push(`本机 claude ${local.version} 比 SDK 配套的 ${target.cli} 新，不降级；子进程先用 SDK 自带的`)
      else {
        step(`本机 claude 换成 ${target.cli}`)
        const failed = await d.installClaude(target.cli)
        if (failed) j.notes.push(`本机 claude 没换成 ${target.cli}，子进程先用 SDK 自带的：\n${failed}`)
        else if (!d.paired()) j.notes.push(`装了 claude ${target.cli}，但 ${local.path} 与 SDK 配套的不是同一个文件（不是原生安装？），子进程先用 SDK 自带的`)
      }
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

  sdk.get('/', async (c) =>
    c.json<SdkStatus>({
      running: d.running,
      installed: d.installed(),
      latest: await latest(),
      local: await d.local(),
      restartable: d.supervised,
      job,
    }),
  )

  // 装了还没重启（没人拉起、当时有会话在跑）时再点：跳过装，只重启
  sdk.post('/upgrade', async (c) => {
    if (working()) return c.json({ error: '正在升级' }, 409)
    starting = true
    try {
      const target = await latest(true)
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
