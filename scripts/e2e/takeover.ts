// 接管终端会话：终端空闲时手机上直接发（确认后关掉终端里的 claude，resume 接着聊，缓存接得上）→ 终端正在跑时「打断并接管」
import { api, check, interactive, run, shot, terminal, testDir, until } from './harness'

const SEND = 'button[aria-label="发送"]'
const lastReply = async (page: import('playwright-core').Page) => (await page.locator('.md').allInnerTexts()).at(-1) ?? ''

await run(
  async ({ page }) => {
    const dir = testDir('takeover')
    // 接管前的确认都点「确定」
    page.on('dialog', (d) => void d.accept())

    const term = await interactive(dir, 'Remember the word: pineapple. Reply with just: ok')
    const t = await until('终端会话出现在概览里', async () =>
      (await api('/sessions')).find((s: any) => s.terminal === 'running' && s.cwd === dir),
    )
    await page.evaluate((id) => (location.hash = `#/s/${id}`), t.id)
    // 只在终端空闲时才有输入框
    await page.waitForSelector('textarea[placeholder="发消息即接管…"]', { timeout: 60_000 })
    // 回什么话跟着用户的语言设置，只认那个词
    await page.waitForSelector('.md >> text=pineapple')
    check(true, '终端空闲时有输入框')
    await shot('1-idle')

    await page.fill('textarea', 'What word did I ask you to remember? Reply with just the word')
    await page.click(SEND)
    await until('终端里的 claude 被关掉', () => !term.running, 15_000)
    await until('接管后的回复', async () => (await api(`/sessions/${t.id}`)).state === 'idle' && (await page.locator('text=/完成 ·/').count()) > 0)
    check(/pineapple/i.test(await lastReply(page)), '接着终端里的对话回答', await lastReply(page))
    const info = await api(`/sessions/${t.id}`)
    check(info.terminal === undefined && info.owned, '接管后是手机上的会话', { terminal: info.terminal, owned: info.owned })
    // 终端发的那一轮已经写过缓存：接管后第一次请求大半是读。消息段能读到多少跟终端里接着发一样看 API（上一轮带不带 thinking 块，实测时有时无），只比读写
    check(info.usage && info.usage.cacheRead > info.usage.cacheCreation, '缓存接上了', info.usage)
    check((await page.locator('nav [aria-current="page"]').count()) === 1, '接管后进标签条并高亮')
    await shot('2-taken')

    const term2 = terminal(
      dir,
      'Use the Bash tool 4 separate times, one call each: `echo step1 && sleep 4`, `echo step2 && sleep 4`, `echo step3 && sleep 4`, `echo step4`. Then reply with just: finished',
      '--allowedTools=Bash',
    )
    const b = await until('正在跑的终端会话', async () =>
      (await api('/sessions')).find((s: any) => s.terminal === 'running' && s.cwd === dir && s.id !== t.id && s.state === 'running'),
    )
    await page.evaluate((id) => (location.hash = `#/s/${id}`), b.id)
    await page.waitForSelector('button:has-text("打断并接管")')
    check((await page.locator('textarea').count()) === 0, '终端在跑时没有输入框')
    // 第二个工具开始了，第一个就 echo 完了（prompt 里也有 step1，不能按字等）
    await until('终端跑完第一个工具', async () => (await page.locator('span.truncate', { hasText: /^\$ / }).count()) >= 2, 60_000)
    await shot('3-running')

    await page.click('button:has-text("打断并接管")')
    await until('终端里的 claude 被关掉', () => !term2.running, 15_000)
    check(!(await term2.output).includes('finished'), '终端那一轮被打断')
    await page.waitForSelector('textarea[placeholder="发消息即续接…"]', { timeout: 10_000 })
    await page.fill('textarea', 'Which step numbers did the Bash tool already echo? Reply with just the digits, comma separated')
    await page.click(SEND)
    await until('打断并接管后的回复', async () => (await api(`/sessions/${b.id}`)).state === 'idle' && (await page.locator('text=/完成 ·/').count()) > 0)
    check(/1/.test(await lastReply(page)), '接着被打断的对话回答', await lastReply(page))
    await shot('4-interrupted')
  },
  { browser: true },
)
