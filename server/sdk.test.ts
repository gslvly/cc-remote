import { describe, expect, test } from 'bun:test'
import type { SdkJob, SdkStatus } from '../shared/protocol'
import { BUSY, type Npm, type Release, type SdkDeps, sdkRoutes, urgent } from './sdk'

const DAY = 86_400_000
const LATEST = { version: '0.3.304', cli: '2.1.304' }
/** SDK 版本 → 配套的 claude */
const PAIR: Record<string, string> = { '0.3.296': '2.1.296', '0.3.304': '2.1.304' }

interface Opts {
  busy?: boolean
  supervised?: boolean
  /** 类型检查过不了的 SDK 版本 */
  broken?: string[]
  installed?: string
  latest?: typeof LATEST
  /** npm 上发过的；默认只有 latest，昨天发的 */
  releases?: Release[]
  /** 本机 claude 的版本；null 是没有本机的 */
  claude?: string | null
  claudeFails?: boolean
  pruneFails?: boolean
}

/** 假的 npm、node_modules 和本机 claude：装什么就变成什么 */
function setup(o: Opts = {}) {
  let installed = o.installed ?? '0.3.296'
  let claude = o.claude === undefined ? '2.1.296' : o.claude
  const calls: string[] = []
  /** 删旧版时留下的 SDK 版本 */
  const pruned: string[] = []
  let lookups = 0
  let restarts = 0
  const deps: Partial<SdkDeps> = {
    npm: async () => {
      lookups++
      const latest = 'latest' in o ? o.latest : LATEST
      return latest && { latest, releases: o.releases ?? [{ ...latest, time: Date.now() - DAY }] }
    },
    installed: () => installed,
    running: { version: '0.3.296', cli: '2.1.296' },
    local: async () => (claude ? { path: '/bin/claude', version: claude, matched: claude === '2.1.296' } : undefined),
    paired: () => claude === PAIR[installed],
    install: async (v) => {
      calls.push(`sdk ${v}`)
      installed = v
    },
    typecheck: async () => (o.broken?.includes(installed) ? 'TS2345 类型不对' : undefined),
    installClaude: async (v) => {
      calls.push(`claude ${v}`)
      if (o.claudeFails) return '下载超时'
      claude = v
    },
    prune: async (v) => {
      pruned.push(v)
      if (o.pruneFails) throw new Error('EACCES')
      return '删了旧版 claude 2.1.296'
    },
    supervised: o.supervised ?? true,
  }
  const app = sdkRoutes(
    () => !!o.busy,
    () => restarts++,
    deps,
  )
  const status = async () => (await (await app.request('/')).json()) as SdkStatus
  /** 发起升级，等后台跑完（或进入重启） */
  const upgrade = async () => {
    const res = await app.request('/upgrade', { method: 'POST' })
    const body = (await res.json()) as SdkJob & { error?: string }
    if (res.status !== 202) return { status: res.status, error: body.error }
    let job = body
    while (job.state === 'running') {
      await Bun.sleep(1)
      job = (await status()).job!
    }
    return { status: res.status, job }
  }
  return {
    app,
    status,
    upgrade,
    calls,
    pruned,
    installed: () => installed,
    claude: () => claude,
    lookups: () => lookups,
    restarts: async () => (await Bun.sleep(350), restarts),
  }
}

describe('sdkRoutes', () => {
  test('状态带上 npm 上的最新版和本机 claude，最新版缓存着', async () => {
    const t = setup()
    expect(await t.status()).toEqual({
      running: { version: '0.3.296', cli: '2.1.296' },
      installed: '0.3.296',
      latest: LATEST,
      local: { path: '/bin/claude', version: '2.1.296', matched: true },
      restartable: true,
      urge: false,
    })
    await t.status()
    expect(t.lookups()).toBe(1)
    await t.app.request('/?fresh')
    expect(t.lookups()).toBe(2)
  })

  test('落后满 7 天就该醒目提示', async () => {
    const t = setup({ releases: [{ ...LATEST, time: Date.now() - 8 * DAY }] })
    expect((await t.status()).urge).toBe(true)
  })

  test('SDK 和本机 claude 一起换成最新的，然后重启', async () => {
    const t = setup()
    const { job } = await t.upgrade()
    expect(job).toMatchObject({ target: LATEST, state: 'restarting', notes: [] })
    expect(t.calls).toEqual(['sdk 0.3.304', 'claude 2.1.304'])
    expect(t.pruned).toEqual(['0.3.304'])
    expect(await t.restarts()).toBe(1)
  })

  test('删旧版失败不影响升级，记下原因', async () => {
    const t = setup({ pruneFails: true })
    const { job } = await t.upgrade()
    expect(job?.state).toBe('restarting')
    expect(job?.notes).toEqual(['旧版没删掉：EACCES'])
  })

  test('本机 claude 已自己更新到配套的，就不再装', async () => {
    const t = setup({ claude: '2.1.304' })
    expect((await t.upgrade()).job?.state).toBe('restarting')
    expect(t.calls).toEqual(['sdk 0.3.304'])
  })

  test('本机 claude 比配套的新就不降级', async () => {
    const t = setup({ claude: '2.1.305' })
    const { job } = await t.upgrade()
    expect(t.calls).toEqual(['sdk 0.3.304'])
    expect(job?.notes[0]).toContain('不降级')
    expect(job?.state).toBe('restarting')
  })

  test('本机 claude 没换成：SDK 照样升级，记下原因', async () => {
    const t = setup({ claudeFails: true })
    const { job } = await t.upgrade()
    expect(job?.state).toBe('restarting')
    expect(job?.notes[0]).toContain('下载超时')
  })

  test('没有本机 claude 就只换 SDK', async () => {
    const t = setup({ claude: null })
    expect((await t.upgrade()).job?.state).toBe('restarting')
    expect(t.calls).toEqual(['sdk 0.3.304'])
  })

  test('SDK 已是最新、只有本机 claude 旧：只换 claude，不重启', async () => {
    const t = setup({ latest: { version: '0.3.296', cli: '2.1.296' }, claude: '2.1.290' })
    expect((await t.upgrade()).job).toMatchObject({ state: 'done', notes: [] })
    expect(t.calls).toEqual(['claude 2.1.296'])
    expect(await t.restarts()).toBe(0)
  })

  test('升级时现查 npm，不用缓存', async () => {
    const t = setup()
    await t.status()
    await t.upgrade()
    expect(t.lookups()).toBe(2)
  })

  test('有托管会话在跑就不动', async () => {
    const t = setup({ busy: true })
    expect(await t.upgrade()).toEqual({ status: 409, error: BUSY })
    expect(t.calls).toEqual([])
  })

  test('类型检查没过就装回原来的，claude 不动，不重启', async () => {
    const t = setup({ broken: ['0.3.304'] })
    const { job } = await t.upgrade()
    expect(job?.state).toBe('failed')
    expect(job?.error).toContain('已装回 0.3.296')
    expect(job?.error).toContain('TS2345')
    expect(t.calls).toEqual(['sdk 0.3.304', 'sdk 0.3.296'])
    expect(t.claude()).toBe('2.1.296')
    expect(t.pruned).toEqual([])
    expect(await t.restarts()).toBe(0)
  })

  test('没有服务管理器拉起就只装不重启', async () => {
    const t = setup({ supervised: false })
    const { job } = await t.upgrade()
    expect(job?.state).toBe('done')
    expect(job?.notes[0]).toContain('到电脑上重启')
    expect(t.installed()).toBe('0.3.304')
    expect(await t.restarts()).toBe(0)
  })

  test('装好了还没重启时再点只重启', async () => {
    const t = setup({ installed: '0.3.304', claude: '2.1.304' })
    expect((await t.upgrade()).job?.state).toBe('restarting')
    expect(t.calls).toEqual([])
    expect(await t.restarts()).toBe(1)
  })

  test('升级中再点、已经是最新、查不到最新版', async () => {
    const t = setup()
    const first = t.app.request('/upgrade', { method: 'POST' })
    expect((await t.app.request('/upgrade', { method: 'POST' })).status).toBe(409)
    expect((await first).status).toBe(202)
    expect((await setup({ latest: { version: '0.3.296', cli: '2.1.296' } }).upgrade()).status).toBe(409)
    expect((await setup({ latest: undefined }).upgrade()).status).toBe(502)
  })
})

describe('urgent', () => {
  const now = Date.parse('2026-10-22T00:00:00Z')
  const running = { version: '0.3.300', cli: '2.1.300' }
  const matched = { path: '/bin/claude', version: '2.1.300', matched: true }
  /** 0.3.301 起每天一版，最后一版是今天发的 */
  const daily = (n: number): Npm => {
    const releases = Array.from({ length: n }, (_, i) => ({ version: `0.3.${301 + i}`, cli: `2.1.${301 + i}`, time: now - (n - 1 - i) * DAY }))
    return { latest: releases.at(-1)!, releases }
  }
  const one = (version: string, cli: string, time = now): Npm => ({ latest: { version, cli }, releases: [{ version, cli, time }] })

  test('天天发版：落后不满 7 天不提示，满了提示', () => {
    expect(urgent(daily(7), running, matched, now)).toBe(false)
    expect(urgent(daily(8), running, matched, now)).toBe(true)
  })

  test('大版本当天就提示：SDK 出了 ^ 的范围、配套 claude 的 x.y 变了', () => {
    expect(urgent(one('0.4.0', '2.1.310'), running, matched, now)).toBe(true)
    expect(urgent(one('1.0.0', '2.1.310'), running, matched, now)).toBe(true)
    expect(urgent(one('0.3.301', '2.2.0'), running, matched, now)).toBe(true)
    expect(urgent(one('0.3.301', '2.1.301'), running, matched, now)).toBe(false)
  })

  test('已是最新不提示，发布多久都一样', () => {
    expect(urgent(one('0.3.300', '2.1.300', now - 30 * DAY), running, matched, now)).toBe(false)
  })

  test('SDK 是最新、本机 claude 旧：一样看大版本和 7 天，比配套的新不提示', () => {
    const npm = (time: number): Npm => ({
      latest: running,
      releases: [
        { version: '0.3.291', cli: '2.1.291', time },
        { ...running, time: now - DAY },
      ],
    })
    const local = (version: string) => ({ path: '/bin/claude', version, matched: false })
    expect(urgent(npm(now - 3 * DAY), running, local('2.1.290'), now)).toBe(false)
    expect(urgent(npm(now - 8 * DAY), running, local('2.1.290'), now)).toBe(true)
    expect(urgent(npm(now - 3 * DAY), running, local('2.0.9'), now)).toBe(true)
    expect(urgent(npm(now - 8 * DAY), running, local('2.1.305'), now)).toBe(false)
  })
})
