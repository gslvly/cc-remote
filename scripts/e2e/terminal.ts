// 终端会话：只读旁观 → 终端退出后直接发消息 resume → 目录页的历史会话 → 打开历史会话发消息自动 resume
import { api, check, run, shot, sleep, terminal, testDir, until } from './harness'

await run(
  async ({ page }) => {
    const dir = testDir('terminal')
    const before = new Set((await api('/sessions')).map((s: { id: string }) => s.id))
    const term = terminal(
      dir,
      'Use the Bash tool 4 separate times, one call each: `echo step1 && sleep 3`, `echo step2 && sleep 3`, `echo step3 && sleep 3`, `echo step4`. Then reply with just: finished',
      '--allowedTools=Bash',
    )

    const t = await until('终端会话出现在概览里', async () =>
      (await api('/sessions')).find((s: any) => s.terminal === 'running' && s.cwd === dir && !before.has(s.id)),
    )
    await page.waitForSelector(`text=${t.title.slice(0, 10)}`)
    check((await page.locator('section >> text=▣').count()) > 0, '首页列表里终端会话带 ▣')
    await shot('1-home')

    await page.evaluate((id) => (location.hash = `#/s/${id}`), t.id)
    await page.waitForSelector('text=终端里正在用这个会话')
    check((await page.locator('textarea').count()) === 0, '终端在跑时只读，没有输入框')
    check((await page.locator('nav [aria-current="page"]').count()) === 0, '终端会话不进标签条')
    const seen: number[] = []
    while (term.running) {
      seen.push(await page.locator('span.truncate', { hasText: /^\$ / }).count())
      await sleep(1000)
    }
    check(new Set(seen).size > 1, '终端运行期间工具行跟着出现', seen.join(','))
    await shot('2-watching')

    // 看着的时候终端退出：直接成了历史会话，输入框出现，不用先接管；还没续接，不进标签条
    await page.waitForSelector('textarea[placeholder="发消息即续接…"]', { timeout: 15_000 })
    await page.waitForSelector('text=finished')
    check((await term.output).includes('finished'), '终端正常结束')
    const info = await api(`/sessions/${t.id}`)
    check(info.terminal === undefined, '终端退出后不再是终端会话', info.terminal)
    check((await page.locator('header >> text=历史').count()) > 0, '页头标「历史」')
    check((await page.locator('nav [aria-current="page"]').count()) === 0, '没续接的不进标签条')
    await shot('3-exited')

    await page.fill('textarea', 'What was the last step number you echoed? Reply with just the number word, like: four')
    await page.click('button[aria-label="发送"]')
    await until('终端退出后的回复', async () => (await api(`/sessions/${t.id}`)).state === 'idle' && (await page.locator('text=/完成 ·/').count()) > 0)
    check(/four/i.test((await page.locator('.md').allInnerTexts()).at(-1) ?? ''), '接着原对话回答')
    check((await api('/sessions')).some((s: any) => s.id === t.id), '发过消息后进概览')
    check((await page.locator('nav [aria-current="page"]').count()) === 1, '续接后进标签条并高亮')
    await shot('4-resumed')

    await page.evaluate((d) => (location.hash = `#/dir?path=${encodeURIComponent(d)}`), dir)
    await page.waitForSelector('text=历史会话')
    await page.waitForSelector('section li')
    check((await page.locator('section li').count()) >= 1, '目录页列出历史会话')
    await shot('5-dir')

    // 再让终端开一个会话，跑完才打开：没人看着时退出的，就是普通历史会话
    const term2 = terminal(dir, 'Reply with just: hello')
    await term2.exited
    // 服务端每隔几秒扫一次登记表，扫到它退出前还在概览里
    const hist = await until('终端开的会话成为历史会话', async () => {
      const listed = new Set((await api('/sessions')).map((s: { id: string }) => s.id))
      return (await api(`/dir/sessions?path=${encodeURIComponent(dir)}`)).sessions.find((s: any) => !listed.has(s.id))
    })
    await page.evaluate((id) => (location.hash = `#/s/${id}`), hist.id)
    await page.waitForSelector('textarea[placeholder="发消息即续接…"]')
    check((await page.locator('.md', { hasText: 'hello' }).count()) > 0, '历史会话载入了原来的回复')
    await page.fill('textarea', 'Reply with just: resumed-ok')
    await page.click('button[aria-label="发送"]')
    await until('resume 后的回复', async () => (await api(`/sessions/${hist.id}`)).state === 'idle' && (await page.locator('.md', { hasText: 'resumed-ok' }).count()) > 0)
    check((await api('/sessions')).some((s: any) => s.id === hist.id), '历史会话发过消息后进概览')
    await shot('6-resumed')
  },
  { browser: true },
)
