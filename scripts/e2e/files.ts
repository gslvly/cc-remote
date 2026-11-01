// 看文件：选目录时列文件、点开看；工具条目上的「打开」
//  1. 接口：Range 经 Bun.serve 回 206、带 CSP sandbox；roots 外的 403
//  2. 浏览页打开「文件」开关，列出文件和大小（隐藏文件不列）
//  3. 文本带行号；Markdown 渲染、能切源码；图片显示；html 当文本显示、不执行；大文件只显示开头；二进制不预览；
//     下载用原文件名（中文、括号）
//  4. 目录页切到「文件」：进子目录、面包屑回来、点开文件、显示隐藏；离开再回来还在原处
//  5. Claude 用 Write 写的文件，工具条目上点「打开」能看到内容；返回上一页时弹层关掉
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { api, check, run, shot, testDir, text, until } from './harness'

const PNG_1X1 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII='

await run(
  async ({ page }) => {
    const dir = testDir('files')
    writeFileSync(join(dir, 'notes.txt'), 'first line\nsecond line\nthird line\n')
    writeFileSync(join(dir, 'README.md'), '# 标题\n\n正文 **加粗**\n')
    writeFileSync(join(dir, 'pic.png'), Buffer.from(PNG_1X1, 'base64'))
    writeFileSync(join(dir, 'evil.html'), '<script>window.pwned = 1</script><b>x</b>')
    writeFileSync(join(dir, 'big.log'), 'x'.repeat(300 * 1024))
    writeFileSync(join(dir, 'bin.dat'), Buffer.from([1, 2, 0, 3]))
    writeFileSync(join(dir, '报告 (1).txt'), '中文')
    writeFileSync(join(dir, '.secret'), 'hidden')
    mkdirSync(join(dir, 'sub'), { recursive: true })
    writeFileSync(join(dir, 'sub', 'inner.txt'), 'in sub')

    const probe = await page.evaluate(async (p) => {
      const r = await fetch(`/api/fs/file?path=${encodeURIComponent(p)}`, { headers: { Range: 'bytes=0-4' } })
      const out = await fetch(`/api/fs/file?path=${encodeURIComponent('/etc/passwd')}`)
      return { status: r.status, body: await r.text(), csp: r.headers.get('content-security-policy'), out: out.status }
    }, join(dir, 'notes.txt'))
    check(probe.status === 206 && probe.body === 'first', 'Range 回 206', probe)
    check(probe.csp === 'sandbox', '响应带 CSP sandbox', probe.csp)
    check(probe.out === 403, 'roots 外的文件 403', probe.out)

    // 浏览页，记住的位置设成测试目录
    await page.evaluate((d) => {
      sessionStorage.setItem('ccr-home-tab', 'browse')
      localStorage.setItem('ccr-browse-path', d)
      localStorage.removeItem('ccr-browse-files')
    }, dir)
    await page.reload()
    await page.getByRole('button', { name: '文件', exact: true }).click()
    await page.locator('li button', { hasText: 'notes.txt' }).waitFor()
    await shot('files-list')
    const listed = await text()
    check(
      ['notes.txt', 'README.md', 'pic.png', '300 KB', '报告 (1).txt'].every((s) => listed.includes(s)) && !listed.includes('.secret'),
      '列出文件和大小，不列隐藏文件',
      listed,
    )

    const dialog = page.getByRole('dialog')
    const open = async (name: string) => {
      await page.locator('li button', { hasText: name }).click()
      await dialog.waitFor()
      await until(`${name} 加载完`, async () => !(await dialog.innerText()).includes('加载中'), 10_000)
    }
    const close = () => page.getByRole('button', { name: '关闭' }).click()

    await open('notes.txt')
    const notes = await dialog.innerText()
    check(/1\s*first line[\s\S]*3\s*third line/.test(notes), '文本带行号', notes)
    const download = page.waitForEvent('download')
    await dialog.getByRole('link', { name: '下载' }).click()
    check((await download).suggestedFilename() === 'notes.txt', '下载用原文件名')
    await shot('files-text')
    await close()

    await open('报告 (1).txt')
    const cn = page.waitForEvent('download')
    await dialog.getByRole('link', { name: '下载' }).click()
    check((await cn).suggestedFilename() === '报告 (1).txt', '中文、括号的文件名', (await cn).suggestedFilename())
    await close()

    await open('README.md')
    check((await dialog.locator('h1').innerText()) === '标题', 'Markdown 渲染')
    await dialog.getByRole('button', { name: '看源码' }).click()
    check((await dialog.innerText()).includes('# 标题'), '切到源码')
    await close()

    await open('pic.png')
    const w = await dialog.locator('img').evaluate((i: HTMLImageElement) => i.decode().then(() => i.naturalWidth, () => 0))
    check(w === 1, '图片显示', w)
    await close()

    await open('evil.html')
    check((await dialog.innerText()).includes('<script>window.pwned = 1</script>'), 'html 当文本显示')
    check((await page.evaluate(() => (window as any).pwned)) === undefined, 'html 里的脚本没跑')
    await close()

    await open('big.log')
    check((await dialog.innerText()).includes('只显示前 256 KB'), '大文件只显示开头')
    await close()

    await open('bin.dat')
    check((await dialog.innerText()).includes('二进制文件'), '二进制不预览')
    await close()
    check((await dialog.count()) === 0, '关掉弹层')

    // 目录页切到「文件」：子目录就地进去、面包屑从这个目录起，点文件全屏看；离开再回来还是「文件」、还在那个子目录
    const goDir = () => page.evaluate((d) => (location.hash = `#/dir?path=${encodeURIComponent(d)}`), dir)
    await page.evaluate(() => {
      localStorage.removeItem('ccr-dir-tab')
      localStorage.removeItem('ccr-files-hidden')
    })
    await goDir()
    await page.getByRole('tab', { name: '文件' }).click()
    await page.locator('li button', { hasText: 'notes.txt' }).waitFor()
    const dirFiles = await text('section')
    check(dirFiles.includes('sub') && dirFiles.includes('README.md') && !dirFiles.includes('.secret'), '目录页列出子目录和文件', dirFiles)
    await page.locator('li button', { hasText: /^sub/ }).click()
    await page.locator('li button', { hasText: 'inner.txt' }).waitFor()
    const trail = (await text('section nav')).replace(/\s/g, '')
    check(trail === 'files/sub', '进子目录，面包屑从这个目录起', trail)
    await shot('files-dir-tab')
    await open('inner.txt')
    check((await dialog.innerText()).includes('in sub'), '目录页点文件全屏看')
    await close()
    await page.evaluate(() => (location.hash = '#/'))
    await goDir()
    await page.locator('li button', { hasText: 'inner.txt' }).waitFor()
    check(true, '回到目录页还是「文件」、还在子目录')
    await page.locator('section nav button', { hasText: 'files' }).click()
    await page.locator('li button', { hasText: 'notes.txt' }).waitFor()
    await page.getByRole('button', { name: '显示隐藏' }).click()
    await page.locator('li button', { hasText: '.secret' }).waitFor()
    check(true, '面包屑回到目录，显示隐藏文件')

    // 工具条目上的「打开」
    const s = await api('/sessions', {
      cwd: dir,
      prompt: 'Use the Write tool to create the file out.txt in the current directory with exactly this content: hello from claude. Then reply with just: ok',
      permissionMode: 'acceptEdits',
    })
    await until('这一轮结束', async () => (await api(`/sessions/${s.id}`)).state === 'idle', 120_000)
    await page.evaluate((id) => (location.hash = `#/s/${id}`), s.id)
    const openBtn = page.getByRole('button', { name: '打开', exact: true })
    await openBtn.first().waitFor()
    await shot('files-row')
    await openBtn.first().click()
    await until('out.txt 加载完', async () => (await dialog.innerText()).includes('hello from claude'), 10_000)
    check(true, '工具条目上点「打开」看到 Claude 写的文件')
    await shot('files-tool')
    await page.evaluate(() => history.back())
    await until('返回后弹层关掉', async () => (await dialog.count()) === 0, 5_000)
    check(true, '返回上一页时弹层关掉')
  },
  { browser: true },
)
