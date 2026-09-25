// 状态栏：页面上的数值与 Claude Code 上报的一致（口径照抄 CLI 拼 statusline 输入的算法，这里独立再算一遍）
//  1. 托管会话：模型、上下文上限，SDK 流里原始用量算出的上下文、缓存，rate_limit_event 算出的 5h / 7d；首页额度同上
//  2. 终端会话：跑这个脚本的 Claude Code 终端会话，上下文 k 数、缓存命中率与它的 statusline 状态文件里记的用量一致
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { api, check, events, run, shot, testDir, until } from './harness'

/** CLI 模型表里 haiku 的 display_name 和上下文上限（测试服务端用 haiku） */
const HAIKU = { name: 'Haiku 4.5', window: 200_000 }

const bar = async (page: import('playwright-core').Page, sel: string) => (await page.locator(sel).first().innerText()).replace(/\s+/g, ' ').trim()

/** 5h / 7d 的剩余：CLI 把 0–1 乘 100 保留一位，statusline 显示 100 − 它，取整 */
const left = (util: number) => Math.round(100 - Math.round(util * 1000) / 10)

await run(
  async ({ page }) => {
    // 1. 托管会话
    const dir = testDir('status')
    const s = await api('/sessions', { cwd: dir, prompt: 'Reply with just: ok' })
    const stream = events(s.id)
    await page.evaluate((id) => (location.hash = `#/s/${id}`), s.id)
    const info = await until('这一轮结束、有用量', async () => {
      const i = await api(`/sessions/${s.id}`)
      return i.state === 'idle' && i.usage && i.contextWindow ? i : undefined
    })
    const sdk = stream.msgs.filter((m) => m.event === 'ev' && m.data.ev.type === 'sdk').map((m) => m.data.ev.msg)
    const raw = sdk.filter((m) => m.type === 'assistant' && !m.parent_tool_use_id).at(-1)?.message.usage
    const limits = sdk.filter((m) => m.type === 'rate_limit_event').at(-1)?.rate_limit_info.unifiedWindows
    check(raw && limits, 'SDK 流里有用量和 rate_limit_event')

    check(info.contextWindow === HAIKU.window, '上下文上限按模型问到了', info.contextWindow)
    check(info.effort === undefined, 'haiku 不带 effort', info.effort)
    await page.waitForSelector(`header >> text=${HAIKU.name}`)
    check((await bar(page, 'header p')).endsWith(`${HAIKU.name} · 200k`), '标题下面：目录 · 模型 · 上限', await bar(page, 'header p'))

    const total = raw.input_tokens + raw.cache_creation_input_tokens + raw.cache_read_input_tokens
    const tier = raw.cache_creation?.ephemeral_5m_input_tokens > 0 && !(raw.cache_creation?.ephemeral_1h_input_tokens > 0) ? 300 : 3600
    check(info.usage.ttl === tier, '缓存档位按用量里的细分', info.usage.ttl)
    const ctx = `上下文 ${Math.round((total / HAIKU.window) * 100)}% ${Math.floor(total / 1000)}k`
    const hit = `缓存 ${Math.floor((raw.cache_read_input_tokens * 100) / total)}%`
    const quota = `5h 剩${left(limits.five_hour.utilization)}% · 7d 剩${left(limits.seven_day.utilization)}%`
    await page.waitForSelector('[aria-label=状态栏] >> text=/5h 剩/')
    const text = await bar(page, '[aria-label=状态栏]')
    const leftMin = Math.floor((Math.floor(info.usage.at / 1000) + info.usage.ttl - Math.floor(Date.now() / 1000)) / 60)
    check(text.startsWith(`${ctx} ${hit} `), '上下文、缓存与 SDK 报的用量一致', { text, ctx, hit })
    check(new RegExp(`^${hit} (${leftMin}|${leftMin - 1})m$`).test(text.match(/缓存 \S+ \S+/)?.[0] ?? ''), '缓存倒计时', text)
    check(text.includes(quota.split(' · ')[0]!) && text.includes(quota.split(' · ')[1]!), '5h / 7d 与 rate_limit_event 一致', { text, quota })
    await shot('status-1-session')

    await page.evaluate(() => (location.hash = '#/'))
    await page.waitForSelector('[aria-label=额度] >> text=/7d 剩/')
    const home = await bar(page, '[aria-label=额度]')
    check(home.includes(quota.split(' · ')[0]!) && home.includes(quota.split(' · ')[1]!), '首页额度', home)
    await shot('status-2-home')

    // 2. 终端会话：就是跑这个脚本的那个。它的 statusline 把最近一次用量记在状态文件里（cache_read_cache_creation_input）
    const sid = process.env.CLAUDE_CODE_SESSION_ID
    const file = join(process.env.TMPDIR || '/tmp', `claude-sl-cache-${sid}.state`)
    if (!sid || !existsSync(file)) return console.log('（不在 Claude Code 终端里跑，跳过终端会话的比对）')
    const [read, creation, input] = readFileSync(file, 'utf8').split(' ')[0]!.split('_').map(Number) as [number, number, number]
    const t = read + creation + input
    await page.evaluate((id) => (location.hash = `#/s/${id}`), sid)
    await page.waitForSelector('[aria-label=状态栏] >> text=/缓存 \\d/')
    const term = await bar(page, '[aria-label=状态栏]')
    check(term.includes(`% ${Math.floor(t / 1000)}k 缓存 ${Math.floor((read * 100) / t)}%`), '终端会话的上下文、缓存与终端 statusline 记的用量一致', { term, read, creation, input })
    check((await bar(page, 'header p')).includes('Opus 5.5'), '终端会话的模型从 transcript 取', await bar(page, 'header p'))
    await shot('status-3-terminal')
  },
  { browser: true },
)
