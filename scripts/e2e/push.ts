// 批次 9：推送。本地起一个假的 ntfy 收推送；页面切到后台（visibilitychange）当作锁屏：
//  1. 页面在前台（概览流连着）：一轮结束不推
//  2. 切到后台：待批准要推，高优先级、带深链接；冷启动打开深链接直接弹出审批，在前台批准、这一轮结束都不推
//  3. 再切到后台：一轮结束推「完成」，正文是回复
import type { Page } from 'playwright-core'
import { api, BASE, check, events, run, shot, sleep, testDir, until } from './harness'

const got: any[] = []
const ntfy = Bun.serve({
  hostname: '127.0.0.1',
  port: 0,
  fetch: async (req) => {
    got.push(await req.json())
    return Response.json({ id: String(got.length) })
  },
})

/** 前台 / 后台：改掉 visibilityState 再发 visibilitychange，页面照真的切后台那样断开流 */
const setVisible = (page: Page, visible: boolean) =>
  page.evaluate((v) => {
    Object.defineProperty(document, 'visibilityState', { value: v ? 'visible' : 'hidden', configurable: true })
    document.dispatchEvent(new Event('visibilitychange'))
  }, visible)

const idle = (id: string) => until('这一轮结束', async () => (await api(`/sessions/${id}`)).state === 'idle', 120_000)

await run(
  async ({ page }) => {
    const dir = testDir('push')
    // ── 1. 前台 ──
    const s = await api('/sessions', { cwd: dir, prompt: 'Reply with just: ok' })
    const stream = events(s.id)
    await idle(s.id)
    await sleep(1000)
    check(got.length === 0, '页面在前台时，一轮结束不推', got)

    // ── 2. 后台时待批准 ──
    await setVisible(page, false)
    await sleep(1000)
    await api(`/sessions/${s.id}/messages`, { text: 'Run exactly this bash command: date > stamp.txt' })
    const n = await until('收到待批准推送', () => got[0], 120_000)
    const req = stream.msgs.find((m) => m.event === 'ev' && m.data.ev.type === 'permission_request')?.data.ev.req
    console.log(`  [实测] Bash 审批请求：${JSON.stringify({ title: req?.title, displayName: req?.displayName, description: req?.description, input: req?.input })}`)
    console.log(`  [实测] 推送：${n.title} / ${n.message}`)
    check(n.topic === 'ccr-e2e' && n.title.startsWith('待批准 · Reply with just: ok') && n.message, '待批准推送：标题带会话名，正文说要干什么', n)
    check(n.priority === 4, '待批准是高优先级', n.priority)
    check(n.click === `${BASE}/#/s/${s.id}`, '深链接进这个会话', n.click)

    // 点开推送：冷启动打开深链接
    await page.goto('about:blank')
    await page.goto(n.click)
    await page.waitForSelector('text=需要批准', { timeout: 15_000 })
    check(true, '打开深链接直接弹出审批')
    await shot('push-1-approval')
    await page.locator('div.fixed button', { hasText: /^允许$/ }).click()
    await idle(s.id)
    await sleep(1000)
    check(got.length === 1, '在前台批准、这一轮结束都不推', got.slice(1))

    // ── 3. 后台时一轮结束 ──
    await setVisible(page, false)
    await sleep(1000)
    await api(`/sessions/${s.id}/messages`, { text: 'Reply with just: done' })
    const d = await until('收到完成推送', () => got[1], 120_000)
    check(d.title.startsWith('完成 · ') && /done/i.test(d.message) && d.click === n.click && d.priority === undefined, '一轮结束推「完成」，正文是回复', d)
    await sleep(1000)
    check(got.length === 2, '没有多推', got.slice(2))
  },
  { browser: true, env: { CCR_PUSH: JSON.stringify({ ntfy: { server: `http://127.0.0.1:${ntfy.port}`, topic: 'ccr-e2e' } }) } },
)
