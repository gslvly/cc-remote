// 网页推送：
//  1. 非安全来源（http://<域名或 IP>，这里用 host-resolver-rules 把 ccr.test 指到本机）：不显示开关，页面不报错
//  2. localhost 是安全来源：点「开启通知」真订阅（Chrome 走 FCM），服务端记下订阅
//  3. 页面切到后台，一轮结束：服务端经推送服务真推过去，SW 弹出通知
//  4. 关闭：退订，服务端删掉订阅
// Playwright 默认的上下文是无痕的，Chrome 无痕不支持 Push API，所以 2–4 用持久化的 profile
import { existsSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { chromium, type Page } from 'playwright-core'
import { CONFIG_DIR, loadConfig } from '../../server/config'
import { api, BASE, check, OUT, PORT, run, sleep, testDir, until } from './harness'

// 测试服务端用的是真实的 ~/.cc-remote：原来没有 webpush.json 的话测完删掉
const FILE = join(CONFIG_DIR, 'webpush.json')
const existed = existsSync(FILE)
const subs = (): { endpoint: string }[] => (existsSync(FILE) ? JSON.parse(readFileSync(FILE, 'utf8')).subscriptions : [])
const PROFILE = join(OUT, 'chrome-webpush')
const token = loadConfig().config.token

const login = async (p: Page, origin: string) => {
  await p.goto(`${origin}/api/build`)
  await p.evaluate((token) => fetch('/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token }) }), token)
  await p.goto(`${origin}/`)
  await p.getByText('cc-remote').first().waitFor()
}

const setVisible = (p: Page, visible: boolean) =>
  p.evaluate((v) => {
    Object.defineProperty(document, 'visibilityState', { value: v ? 'visible' : 'hidden', configurable: true })
    document.dispatchEvent(new Event('visibilitychange'))
  }, visible)

await run(
  async ({ page }) => {
    // harness 的页面连着概览流会挡住推送，用不上，关掉
    await page.close()
    try {
      // ── 1. 非安全来源 ──
      const insecure = await chromium.launch({ channel: 'chrome', args: ['--host-resolver-rules=MAP ccr.test 127.0.0.1'] })
      const p1 = await (await insecure.newContext({ viewport: { width: 390, height: 844 } })).newPage()
      const errors: string[] = []
      p1.on('pageerror', (e) => errors.push(e.message))
      p1.on('console', (m) => m.type() === 'error' && errors.push(m.text()))
      await login(p1, `http://ccr.test:${PORT}`)
      await sleep(1500)
      check((await p1.evaluate(() => isSecureContext)) === false, '非安全来源')
      check(!(await p1.locator('body').innerText()).includes('通知'), '非安全来源：不显示通知开关')
      check(errors.length === 0, '非安全来源：页面没有报错', errors)
      await insecure.close()

      // ── 2. 安全来源：开启 ──
      rmSync(PROFILE, { recursive: true, force: true })
      const ctx = await chromium.launchPersistentContext(PROFILE, { channel: 'chrome', viewport: { width: 390, height: 844 }, permissions: ['notifications'] })
      const p = ctx.pages()[0] ?? (await ctx.newPage())
      p.on('pageerror', (e) => console.log(`  [pageerror] ${e.message}`))
      p.on('dialog', (d) => {
        console.log(`  [dialog] ${d.message()}`)
        void d.accept()
      })
      await login(p, BASE)
      await p.getByRole('button', { name: '开启通知' }).waitFor({ timeout: 10_000 })
      check(true, '安全来源：显示「开启通知」')
      await p.getByRole('button', { name: '开启通知' }).click()
      await p.getByRole('button', { name: '通知已开' }).waitFor({ timeout: 20_000 })
      const endpoint = await p.evaluate(async () => (await (await navigator.serviceWorker.ready).pushManager.getSubscription())?.endpoint)
      check(subs().some((s) => s.endpoint === endpoint), '服务端记下了订阅', endpoint?.slice(0, 60))

      // ── 3. 切后台，一轮结束 → 真推 ──
      await setVisible(p, false)
      await sleep(1000)
      const s = await api('/sessions', { cwd: testDir('webpush'), prompt: 'Reply with just: ok' })
      await until('这一轮结束', async () => (await api(`/sessions/${s.id}`)).state === 'idle', 120_000)
      const shown = await until(
        'SW 弹出通知',
        async () => {
          const l = await p.evaluate(async () =>
            (await (await navigator.serviceWorker.ready).getNotifications()).map((n) => ({ title: n.title, body: n.body, tag: n.tag })),
          )
          return l.length ? l : undefined
        },
        30_000,
      ).catch(() => [])
      check(shown.length === 1 && shown[0]!.title.startsWith('完成 · ') && shown[0]!.tag === s.id, 'SW 弹出了「完成」通知，tag 是会话 id', shown)

      // ── 4. 关闭 ──
      await setVisible(p, true)
      await p.getByRole('button', { name: '通知已开' }).click()
      await p.getByRole('button', { name: '开启通知' }).waitFor({ timeout: 10_000 })
      check(!subs().some((s) => s.endpoint === endpoint), '关闭后服务端删掉了订阅')
      await ctx.close()
    } finally {
      rmSync(PROFILE, { recursive: true, force: true })
      if (!existed) rmSync(FILE, { force: true })
    }
  },
  { browser: true },
)
