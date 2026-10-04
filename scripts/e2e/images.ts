// 发图片：附件按钮选一张大图、粘贴一张小图，一起发给 Claude
//  1. 大图（3000×2000 PNG）按比例缩到 1568×1045、转 JPEG；小图（200×100 PNG）原样发，不放大
//  2. Claude 认得出图里的数字和颜色；用户气泡显示「2 张图片」，缩略图发完清空
//  3. 目录页开新会话：只贴一张图不打字，弹层里选 Haiku、接受编辑，新会话按选的启动
import type { Page } from 'playwright-core'
import { api, check, run, shot, testDir, text, until } from './harness'

const idle = (id: string) => until('这一轮结束', async () => (await api(`/sessions/${id}`)).state === 'idle', 120_000)
const thumbs = (page: Page, n: number) =>
  until(`${n} 张缩略图`, async () => ((await page.locator('[aria-label="去掉这张图片"]').count()) === n ? true : undefined), 10_000)

/** 往输入框里粘贴一张 PNG（base64） */
const paste = (page: Page, b64: string) =>
  page.evaluate(async (b64) => {
    const blob = await (await fetch(`data:image/png;base64,${b64}`)).blob()
    const dt = new DataTransfer()
    dt.items.add(new File([blob], 'small.png', { type: 'image/png' }))
    document.querySelector('textarea')!.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }))
  }, b64)

await run(
  async ({ page }) => {
    const dir = testDir('images')
    const s = await api('/sessions', { cwd: dir, prompt: 'Reply with just: ok' })
    await idle(s.id)
    await page.evaluate((id) => (location.hash = `#/s/${id}`), s.id)
    await page.waitForSelector('textarea')

    // 页面里画两张 PNG：大的白底黑字 73，小的纯红
    const [big, small] = await page.evaluate(() =>
      [
        [3000, 2000, '#fff'],
        [200, 100, '#f00'],
      ].map(([w, h, bg]) => {
        const c = document.createElement('canvas')
        c.width = w as number
        c.height = h as number
        const ctx = c.getContext('2d')!
        ctx.fillStyle = bg as string
        ctx.fillRect(0, 0, c.width, c.height)
        if (c.width > 1000) {
          ctx.fillStyle = '#000'
          ctx.font = 'bold 1200px sans-serif'
          ctx.fillText('73', 600, 1600)
        }
        return c.toDataURL('image/png').split(',')[1]!
      }),
    )

    // 大图走附件按钮，小图走粘贴
    await page.locator('input[type=file]').setInputFiles({ name: 'big.png', mimeType: 'image/png', buffer: Buffer.from(big!, 'base64') })
    await paste(page, small!)
    await thumbs(page, 2)
    await shot('images-picked')

    await page.getByRole('textbox').fill('What number is in the first image, and what color is the second image? Answer like: 12, blue')
    const req = page.waitForRequest((r) => r.url().endsWith('/messages') && r.method() === 'POST')
    await page.getByRole('button', { name: '发送' }).click()
    const body = (await req).postDataJSON() as { images: { mediaType: string; data: string }[] }
    const sizes = await page.evaluate(
      (imgs) =>
        Promise.all(
          imgs.map(async (i) => {
            const img = new Image()
            img.src = `data:${i.mediaType};base64,${i.data}`
            await img.decode()
            return `${i.mediaType} ${img.naturalWidth}x${img.naturalHeight}`
          }),
        ),
      body.images,
    )
    check(sizes[0] === 'image/jpeg 1568x1045', '大图按比例缩到长边 1568、转 JPEG', sizes[0])
    check(sizes[1] === 'image/png 200x100', '小图原样（不放大、不转格式）', sizes[1])
    check(body.images[1]?.data === small, '小图字节没动')

    await idle(s.id)
    check((await page.locator('[aria-label="去掉这张图片"]').count()) === 0, '发完缩略图清空')
    const all = await text()
    await shot('images-sent')
    check(all.includes('［2 张图片］'), '用户气泡显示 2 张图片')
    const reply = all.split('［2 张图片］')[1] ?? ''
    check(reply.includes('73') && /red/i.test(reply), 'Claude 认出了数字和颜色', reply.slice(0, 300))

    // ── 3. 目录页：只贴一张图，选 Haiku、接受编辑 ──
    await page.evaluate((d) => (location.hash = `#/dir?path=${encodeURIComponent(d)}`), dir)
    await page.waitForSelector('text=历史会话')
    await paste(page, small!)
    await thumbs(page, 1)
    const picker = page.getByRole('button', { name: '模型和权限模式' })
    await picker.click()
    await page.locator('button', { hasText: 'Haiku 4.5' }).click()
    await page.locator('[role="group"][aria-label="权限模式"] button', { hasText: '接受编辑' }).click()
    await page.getByRole('button', { name: '完成' }).click()
    check((await picker.textContent()) === 'Haiku · 接受编辑', '按钮上显示选了的', await picker.textContent())
    await shot('dir-picked')

    const create = page.waitForRequest((r) => r.url().endsWith('/api/sessions') && r.method() === 'POST')
    await page.getByRole('button', { name: '开始' }).click()
    const sent = (await create).postDataJSON() as { prompt: string; images: unknown[]; model?: string; permissionMode?: string }
    check(sent.prompt === '' && sent.images.length === 1 && sent.model === 'haiku' && sent.permissionMode === 'acceptEdits', '请求带上图片、模型、模式', sent.model)
    await page.waitForURL(/#\/s\//)
    const id = page.url().split('#/s/')[1]!
    await idle(id)
    const info = await api(`/sessions/${id}`)
    check(/haiku/.test(info.model) && info.permissionMode === 'acceptEdits', '新会话用 Haiku、接受编辑', `${info.model} ${info.permissionMode}`)
    const after = (await text()).split('［1 张图片］')[1] ?? ''
    await shot('dir-started')
    // 没打字时它可能用中文答
    check(/red|红/i.test(after), 'Claude 看到了图', after.slice(0, 300))
  },
  { browser: true },
)
