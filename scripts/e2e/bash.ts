// ! 命令（终端里的 shell 模式）
//  1. 没有子进程时（关掉后）用接口跑：命令和输出进内容流，交给现起的子进程后状态回到 idle，不卡在 starting
//  2. 页面里打 ! 开头：输入框变命令模式，发出去跑，输出等宽显示；跑长命令时点停止能停掉
//  3. 下一条消息 Claude 看得到前面的命令输出；关掉再打开，缓冲与 transcript 对得上（不整段重建）
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { api, check, events, OUT, run, shot, sleep, testDir, text, until } from './harness'

const idle = (id: string) => until('这一轮结束', async () => (await api(`/sessions/${id}`)).state === 'idle', 120_000)

await run(
  async ({ page }) => {
    const dir = testDir('bash')
    const secret = `kiwi-${Math.floor(Math.random() * 9000 + 1000)}`
    writeFileSync(join(dir, 'secret.txt'), `${secret}\n`)
    const s = await api('/sessions', { cwd: dir, prompt: 'Reply with just: ok' })
    await idle(s.id)

    // 1. 关掉（停子进程）后用接口跑
    await api(`/sessions/${s.id}/close`, {})
    const ev = events(s.id)
    await api(`/sessions/${s.id}/bash`, { command: 'cat secret.txt' })
    await until('输出到达', () => ev.lines().some((l) => l.includes(`note ${secret}`)), 10_000)
    await idle(s.id)
    await sleep(2000)
    const info = await api(`/sessions/${s.id}`)
    check(info.state === 'idle' && info.live, '交给现起的子进程，状态回到 idle', { state: info.state, live: info.live })
    check(ev.lines().some((l) => l.endsWith('> ! cat secret.txt')), '命令进内容流', ev.lines())
    check(!ev.lines().some((l) => l.includes('result:')), 'CLI 回的 0 轮 result 不进缓冲（不显示「完成」、不推送）')
    ev.close()

    // 2. 页面里跑
    await page.evaluate((id) => (location.hash = `#/s/${id}`), s.id)
    await page.waitForSelector('textarea')
    await page.getByRole('textbox').fill('!echo $((6*7))zebra')
    check((await text()).includes('命令模式'), '! 开头显示命令模式提示')
    await page.keyboard.press('Enter')
    await until('页面上出现输出', async () => (await text()).includes('42zebra'), 10_000)
    check((await page.getByRole('textbox').inputValue()) === '', '发出去后输入框清空')
    check((await page.locator('pre', { hasText: '42zebra' }).count()) === 1, '输出等宽显示')

    await page.getByRole('textbox').fill('!sleep 30')
    await page.keyboard.press('Enter')
    await until('跑起来', async () => (await api(`/sessions/${s.id}`)).state === 'running', 5000)
    await page.getByRole('button', { name: '中断' }).click()
    await until('停掉', async () => (await text()).includes('Interrupted'), 5000)
    await shot('bash')

    // 3. Claude 看得到；关掉再打开对得上
    await page.getByRole('textbox').fill('List the outputs of the shell commands I ran above, one per line, nothing else.')
    await page.keyboard.press('Enter')
    await sleep(1000)
    await idle(s.id)
    const reply = (await text()).split('nothing else.').at(-1) ?? ''
    check(reply.includes(secret) && reply.includes('42zebra'), 'Claude 看到了命令输出', reply.slice(0, 300))

    await api(`/sessions/${s.id}/close`, {})
    await api(`/sessions/${s.id}`)
    check(!readFileSync(join(OUT, 'server.log'), 'utf8').includes('整段重建'), '关掉再打开，缓冲与 transcript 对得上')
  },
  { browser: true },
)
