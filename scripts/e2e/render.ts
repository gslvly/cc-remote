// 批次 7：plan 模式下「提问 → 计划 → 批准 → 改代码」全程在页面上操作；切模式；一般审批的拒绝附话、本会话都允许；
// 子代理卡片与 Todo 进度条。顺带记下实测：AskUserQuestion 多选的回答格式、ExitPlanMode 计划正文所在字段
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Page } from 'playwright-core'
import { api, check, events, run, shot, testDir, text, until } from './harness'

const footers = (page: Page) => page.locator('p', { hasText: /^(完成 ·|已中断|执行出错)/ }).count()
const allow = (page: Page) => page.locator('div.fixed button', { hasText: /^允许$/ }).click()

/** 等这一轮跑完：服务端空闲、页面上多了 result 页脚。approve：途中的一般审批都放行 */
async function turnDone(page: Page, id: string, results: number, approve = false) {
  await until('这一轮结束', async () => {
    if (approve && (await page.locator('div.fixed >> text=需要批准').count())) await allow(page)
    return (await api(`/sessions/${id}`)).state === 'idle' && (await footers(page)) > results
  }, 180_000)
}

/** 等某个弹层出现；途中冒出来的一般审批（模型先去看了看文件之类）都放行 */
async function waitSheet(page: Page, label: string) {
  await until(`弹层「${label}」`, async () => {
    if (await page.locator(`div.fixed >> text=${label}`).count()) return true
    if (await page.locator('div.fixed >> text=需要批准').count()) {
      console.log(`  （顺手批准：${(await text('div.fixed h3')).trim()}）`)
      await allow(page)
    }
    return false
  }, 150_000)
}

/** 内容流里收到的全部事件（hello 补的 + 之后推的） */
const allEvents = (msgs: { event: string; data: any }[]) =>
  msgs.flatMap(({ event, data }) => (event === 'hello' ? data.events.map((e: any) => e.ev) : event === 'ev' ? [data.ev] : []))

await run(
  async ({ page }) => {
    const dir = testDir('render')
    writeFileSync(join(dir, 'greet.txt'), 'hello\n')

    // ── 1. 目录页选 plan 模式开会话 ──
    await page.evaluate((d) => (location.hash = `#/dir?path=${encodeURIComponent(d)}`), dir)
    await page.waitForSelector('text=历史会话')
    await page.selectOption('select[aria-label="权限模式"]', 'plan')
    await page.fill('textarea', [
      'greet.txt currently contains "hello". Without reading any files first, use the AskUserQuestion tool exactly once, with two questions:',
      '(1) header "Greeting", question "Which greeting should greet.txt use?", multiSelect false, options "hi" and "hey";',
      '(2) header "Extras", question "Which extras should be appended after the greeting?", multiSelect true, options "emoji", "name", "date".',
      'Then make a short plan to rewrite greet.txt accordingly and call ExitPlanMode.',
      'After the plan is approved, use the Edit tool to change greet.txt (do not use Write), then reply with just: done',
    ].join(' '))
    await page.click('button:has-text("开始")')
    await page.waitForURL(/#\/s\//)
    const id = page.url().split('#/s/')[1]!
    const stream = events(id)
    check((await api(`/sessions/${id}`)).permissionMode === 'plan', '新会话按选的 plan 模式启动')

    // ── 2. 提问：单选点 hi，多选点 emoji 和 name ──
    await waitSheet(page, 'Claude 在问你')
    await shot('1-question')
    const option = (label: string) =>
      page.locator('button[aria-pressed]', { has: page.locator('span.font-medium', { hasText: new RegExp(`^(☐ |☑ )?${label}$`) }) })
    await option('hi').click()
    await option('emoji').click()
    await option('name').click()
    check((await option('emoji').getAttribute('aria-pressed')) === 'true', '多选的选项点了是选中状态')
    await page.click('button:has-text("提交")')

    // ── 3. 计划：全文显示，批准并自动接受编辑 ──
    await waitSheet(page, '计划待批准')
    const plan = await text('div.fixed')
    check(plan.length > 40 && !plan.includes('没有收到计划正文'), '计划弹层里有计划全文', plan.slice(0, 80))
    await shot('2-plan')
    await page.click('button:has-text("批准，自动接受编辑")')
    await turnDone(page, id, 0)
    await shot('3-done')

    const greet = readFileSync(join(dir, 'greet.txt'), 'utf8')
    check(/hi/i.test(greet) && greet !== 'hello\n', '按回答改了文件', greet.trim())
    check((await page.locator('span', { hasText: /^Edit .*greet\.txt/ }).count()) > 0, 'Edit 行显示文件名')
    check((await page.locator('span.text-emerald-500', { hasText: /^\+\d+$/ }).count()) > 0, 'Edit 行显示 +N')
    check((await page.locator('button', { hasText: '已批准' }).count()) > 0, '计划卡片显示已批准')
    check((await api(`/sessions/${id}`)).permissionMode === 'acceptEdits', '批准后切到了接受编辑')

    // 实测记录
    const evs = allEvents(stream.msgs)
    const planReq = evs.find((e: any) => e.type === 'permission_request' && e.req.toolName === 'ExitPlanMode')?.req
    console.log(`  [实测] ExitPlanMode 请求的 input 字段：${Object.keys(planReq?.input ?? {}).join(', ')}`)
    check(typeof planReq?.input.plan === 'string' && planReq.input.plan.length > 0, 'ExitPlanMode 的计划正文在 input.plan')
    const askId = evs.find((e: any) => e.type === 'permission_request' && e.req.toolName === 'AskUserQuestion')?.req.toolUseId
    const askResult = evs
      .flatMap((e: any) => (e.type === 'sdk' && e.msg.type === 'user' ? e.msg.message.content : []))
      .find((b: any) => b.type === 'tool_result' && b.tool_use_id === askId)
    const askText = typeof askResult?.content === 'string' ? askResult.content : askResult?.content?.map((c: any) => c.text).join('')
    console.log(`  [实测] AskUserQuestion 的结果：${askText}`)
    check(/emoji, name/.test(askText ?? ''), '多选的回答用逗号拼接后交给 Claude')
    const modes = evs.filter((e: any) => e.type === 'sdk' && e.msg.type === 'system' && e.msg.permissionMode).map((e: any) => `${e.msg.subtype}:${e.msg.permissionMode}`)
    console.log(`  [实测] 带 permissionMode 的 system 消息：${modes.join(' ')}`)

    // ── 4. 输入框左边切模式 ──
    await page.selectOption('select[aria-label="权限模式"]', 'default')
    await until('切到默认模式', async () => (await api(`/sessions/${id}`)).permissionMode === 'default', 10_000)
    check(true, '输入框左边切模式生效')

    // ── 5. 一般审批：拒绝时附一句话，Claude 照着接着做（不中断）──
    let n = await footers(page)
    await page.fill('textarea', 'Run exactly this bash command: date > stamp.txt')
    await page.click('button[aria-label="发送"]')
    await page.waitForSelector('text=需要批准', { timeout: 120_000 })
    check((await page.locator('button:has-text("本会话都允许")').count()) > 0, '有「本会话都允许」', await text('div.fixed'))
    await shot('4-permission')
    await page.fill('input[placeholder^="拒绝时"]', 'Do not create files. Reply with just: skipped')
    await page.click('button:has-text("拒绝并告诉它")')
    await turnDone(page, id, n)
    check((await page.locator('p', { hasText: /^已中断$/ }).count()) === 0, '附话拒绝不中断这一轮')
    check(/skipped/i.test((await page.locator('.md').allInnerTexts()).at(-1) ?? ''), 'Claude 照附的话做了')

    // 本会话都允许：这次放行，同样的命令之后不再问。
    // 用不写文件的命令：重定向写文件的，CLI 另有一道写路径的检查，加了规则照样问（终端里也一样，见 REFERENCE.md）
    const cmd = 'node -e "console.log(42)"'
    n = await footers(page)
    await page.fill('textarea', `That's fine. Now run exactly this bash command: ${cmd}`)
    await page.click('button[aria-label="发送"]')
    await page.waitForSelector('text=需要批准', { timeout: 120_000 })
    await page.click('button:has-text("本会话都允许")')
    await turnDone(page, id, n)
    n = await footers(page)
    await page.fill('textarea', `Run exactly the same bash command again: ${cmd}`)
    await page.click('button[aria-label="发送"]')
    await turnDone(page, id, n)
    const rows = await page.locator('span.truncate', { hasText: '$ node -e' }).count()
    const asked = allEvents(stream.msgs).filter((e: any) => e.type === 'permission_request' && String(e.req.input.command).includes('console.log(42)')).length
    check(rows === 2 && asked === 1, '本会话都允许之后，同样的命令不再问', `跑了 ${rows} 次，问了 ${asked} 次`)
    stream.close()

    // ── 6. 子代理卡片、Todo 进度条（haiku 默认有 Task 工具）──
    const s2 = await api('/sessions', {
      cwd: dir,
      permissionMode: 'acceptEdits',
      prompt: [
        'First use TaskCreate twice to create two tasks with subjects "find" and "report".',
        'Then use TaskUpdate to mark "find" in_progress.',
        'Then use the Agent tool once (subagent_type "Explore", run_in_background false) to find which file in this directory contains the word "hi".',
        'Then use TaskUpdate to mark "find" completed. Leave "report" pending. Finally reply with just the file name.',
      ].join(' '),
    })
    await page.evaluate((id) => (location.hash = `#/s/${id}`), s2.id)
    await turnDone(page, s2.id, 0, true)
    await shot('5-agent')
    const card = page.locator('div.rounded-xl', { has: page.locator('span', { hasText: /^Explore · / }) })
    check((await card.count()) > 0, '子代理是一张卡片')
    const calls = Number((await card.first().locator('span.shrink-0', { hasText: /次调用$/ }).innerText()).match(/(\d+)/)?.[1])
    check(calls > 0, '卡片上数出子代理的工具调用', calls)
    await card.first().locator('button').first().click()
    check((await card.first().locator('span.truncate', { hasText: /^(Read|Grep|Glob|\$) / }).count()) > 0, '点开看得到子代理的工具调用')
    const report = await card.first().locator('.md').last().innerText()
    check(/greet\.txt/.test(report) && !report.includes('Subagent hand-back'), '卡片上是子代理的报告，没有 CLI 的来源声明', report.slice(0, 80))
    const bar = await text('body')
    check(/1\/2/.test(bar), 'Todo 进度条显示 1/2', bar.match(/\d\/\d.{0,20}/)?.[0])
    check((await page.locator('span.truncate', { hasText: /^TaskCreate|^TaskUpdate/ }).count()) === 0, 'Task 工具不进消息流')
    await shot('6-agent-open')
  },
  { browser: true },
)
