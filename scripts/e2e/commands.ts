// 斜杠命令面板、切模型 / effort、草稿。只发本地命令（/context、/model），不调模型
//  1. 目录页打 / 弹出命令列表（滤掉了 /clear 这类），过滤、点选填进输入框；草稿切走再回来还在
//  2. 展示类命令（/context）的输出照常显示；手打的 /clear 被拦
//  3. 点页头的模型切 Sonnet、effort low，活着的子进程真的换了（/model 报的）；同一个弹层切权限模式，页头、输入框描边跟着变
import { check, run, shot, testDir, text, until } from './harness'

await run(
  async ({ page }) => {
    const dir = testDir('commands')
    const goDir = () => page.evaluate((p) => (location.hash = `#/dir?path=${encodeURIComponent(p)}`), dir)
    const names = () => page.locator('[aria-label="命令列表"] button > span:first-child').allInnerTexts()

    // 1. 目录页
    await goDir()
    const box = page.getByRole('textbox')
    await box.fill('/')
    const all = await until('命令列表取到了', async () => ((await names()).includes('/compact') ? names() : undefined), 30_000)
    await shot('commands-menu')
    check(all.includes('/context') && all.includes('/usage'), '展示类命令在列表里', all)
    check(!all.includes('/clear') && !all.includes('/focus'), '/clear、/focus 不在列表里', all)

    await box.fill('/cont')
    check((await names())[0] === '/context', '按前缀过滤，前缀匹配排前面', await names())
    await page.locator('[aria-label="命令列表"] button').first().click()
    check((await box.inputValue()) === '/context ', '点选填进输入框，后面留空格', await box.inputValue())
    check((await page.locator('[aria-label="命令列表"]').count()) === 0, '填完列表收起')

    await page.evaluate(() => (location.hash = '#/'))
    await page.waitForSelector('text=最近')
    await goDir()
    check((await page.getByRole('textbox').inputValue()) === '/context ', '目录页草稿切走再回来还在')

    // 2. 展示类命令的输出；/clear 被拦
    await page.getByRole('button', { name: '开始' }).click()
    await until('/context 的输出显示出来', async () => ((await text()).includes('Context Usage') ? true : undefined), 30_000)
    const composer = page.getByRole('textbox')
    await composer.fill('/clear')
    await composer.press('Enter')
    await until('/clear 被拦', async () => ((await text()).includes('手机上开新会话请用标签条的 [+]') ? true : undefined), 5_000)

    // 草稿：会话页切走再回来还在
    const session = await page.evaluate(() => location.hash)
    await composer.fill('还没发的话')
    await page.evaluate(() => (location.hash = '#/'))
    await page.waitForSelector('text=最近')
    await page.evaluate((h) => (location.hash = h), session)
    await until('会话页回来了', async () => ((await page.getByRole('textbox').count()) ? true : undefined), 5_000)
    check((await page.getByRole('textbox').inputValue()) === '还没发的话', '会话草稿切走再回来还在')

    // 3. 切模型、effort
    await page.locator('header p button').first().click()
    await page.getByRole('button', { name: /^Sonnet/ }).click()
    await until('页头换成 Sonnet', async () => ((await text('header p')).includes('Sonnet') ? true : undefined), 5_000)
    await page.getByRole('button', { name: 'low', exact: true }).click()
    await until('页头带上 effort low', async () => ((await text('header p')).includes('· low') ? true : undefined), 5_000)
    check(true, `页头：${await text('header p')}`)
    await shot('commands-model')

    // 同一个弹层切权限模式：非默认的显示在页头、输入框描边；点页头的模式也打开这个弹层
    const modeChip = (label: string) => page.locator('[role="group"][aria-label="权限模式"] button', { hasText: label })
    await modeChip('规划').click()
    await until('页头带上规划', async () => ((await text('header p')).endsWith('规划') ? true : undefined), 5_000)
    check((await page.getByRole('textbox').getAttribute('class'))?.includes('border-sky-700'), '输入框描成规划的颜色')
    await page.getByRole('button', { name: '完成' }).click()
    await page.locator('header p button', { hasText: '规划' }).click()
    await modeChip('默认').click()
    await until('切回默认，页头不显示模式', async () => (!(await text('header p')).includes('规划') ? true : undefined), 5_000)
    await page.getByRole('button', { name: '完成' }).click()
    check((await page.locator('select[aria-label="权限模式"]').count()) === 0, '输入框左边不再有模式下拉')

    await page.getByRole('textbox').fill('/model')
    await page.getByRole('textbox').press('Enter')
    const reply = await until(
      '/model 报当前模型',
      async () => (await text()).split('\n').find((l) => l.startsWith('Current model:') && l.includes('Sonnet')),
      30_000,
    )
    check(reply.includes('effort: low'), '子进程里模型、effort 都换了', reply)
    check((await page.getByRole('textbox').inputValue()) === '', '发出去后草稿清空')
  },
  { browser: true },
)
