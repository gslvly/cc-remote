// 回退到某条用户消息之前：代码和对话一起、只回退对话、只还原代码。
// acceptEdits 下让 Claude 用 Write 改文件（Bash 改的不留底）：
//  1. 三轮把 a.txt 写成 one → two → three；预览：列出 a.txt、文件不动；第一条的对话回退不了
//  2. 页面上点第三条 →「回退到这里」→ 弹层三个选项 →「只还原代码」：a.txt 回到 two，对话不动
//  3. 只回退对话到第三条之前：a.txt 不动，第三条不见了，子进程停了
//  4. 页面上点第二条 →「代码和对话都回退」：现起的子进程从 transcript 载入检查点，a.txt 回到 one，原文放回输入框
//  5. 再发一条：transcript 从截断处分叉，主链里没有回退掉的两条；新的这条也留了底
//  6. 只还原代码到第一条之前：a.txt、b.txt 都没了，对话不动
import { getSessionMessages } from '@anthropic-ai/claude-agent-sdk'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { api, check, events, run, shot, testDir, text, until } from './harness'

const P1 = 'Use the Write tool to create a.txt containing exactly: one'
const P2 = 'Read a.txt, then use the Write tool to overwrite it so it contains exactly: two'
const P3 = 'Read a.txt, then use the Write tool to overwrite it so it contains exactly: three'
const P4 = 'Use the Write tool to create b.txt containing exactly: four'

const idle = (id: string) => until('这一轮结束', async () => (await api(`/sessions/${id}`)).state === 'idle', 120_000)

/** 内容流里当前缓冲中的用户输入（从最近一次重建算起） */
function inputs(stream: ReturnType<typeof events>): { text: string; uuid: string }[] {
  let evs: any[] = []
  for (const m of stream.msgs) {
    if (m.event === 'hello') evs = m.data.reset ? [...m.data.events] : [...evs, ...m.data.events]
    else if (m.event === 'ev') evs.push(m.data)
  }
  return evs.filter((e) => e.ev.type === 'user_input').map((e) => ({ text: e.ev.text, uuid: e.ev.uuid }))
}

await run(
  async ({ page }) => {
    const dir = testDir('rewind')
    const file = (name: string) => (existsSync(join(dir, name)) ? readFileSync(join(dir, name), 'utf8').trim() : undefined)
    const said = (stream: ReturnType<typeof events>) => inputs(stream).map((i) => i.text)
    const choices = () => page.locator('button', { hasText: /回退|还原代码/ }).allInnerTexts()

    // 1. 三轮改 a.txt
    const s = await api('/sessions', { cwd: dir, prompt: P1, permissionMode: 'acceptEdits' })
    const stream = events(s.id)
    await idle(s.id)
    check(file('a.txt') === 'one', '第一轮写了 one', file('a.txt'))
    for (const [p, want] of [
      [P2, 'two'],
      [P3, 'three'],
    ] as const) {
      await api(`/sessions/${s.id}/messages`, { text: p })
      await idle(s.id)
      check(file('a.txt') === want, `改成 ${want}`, file('a.txt'))
    }
    const [u1, u2, u3] = inputs(stream)
    check(u1?.uuid && u2?.uuid && u3?.uuid, '用户输入带 uuid', inputs(stream))

    const pre = await api(`/sessions/${s.id}/rewind`, { uuid: u3!.uuid, dryRun: true })
    check(pre.files?.canRewind && pre.files.filesChanged?.some((f: string) => f.endsWith('a.txt')) && !pre.conversationBlocked, '预览列出 a.txt', pre)
    check(file('a.txt') === 'three', '预览不动文件', file('a.txt'))
    const pre1 = await api(`/sessions/${s.id}/rewind`, { uuid: u1!.uuid, dryRun: true })
    check(pre1.files?.canRewind && pre1.conversationBlocked?.includes('第一条'), '第一条：代码能还原，对话回退不了', pre1)

    // 2. 页面上只还原代码
    await page.evaluate((id) => (location.hash = `#/s/${id}`), s.id)
    await page.getByText(P3, { exact: true }).click()
    await page.getByRole('button', { name: '↶ 回退到这里' }).click()
    await until('预览出来', async () => ((await text()).includes('还原 1 个文件') ? true : undefined), 30_000)
    await shot('rewind-sheet')
    check((await choices()).join('|') === '代码和对话都回退|只回退对话|只还原代码', '三个选项', await choices())
    await page.getByRole('button', { name: '只还原代码' }).click()
    await until('a.txt 回到 two', () => (file('a.txt') === 'two' ? true : undefined), 30_000)
    await until('弹层关了', async () => ((await text()).includes('回退到这条之前') ? undefined : true), 5_000)
    check((await text()).includes(P3), '对话不动，第三条还在')
    check((await page.locator('textarea').inputValue()) === '', '输入框不填')

    // 3. 只回退对话
    const r3 = await api(`/sessions/${s.id}/rewind`, { uuid: u3!.uuid, restore: 'conversation' })
    check(!r3.files, '没碰文件', r3)
    check(file('a.txt') === 'two', 'a.txt 不动', file('a.txt'))
    check(said(stream).join('|') === [P1, P2].join('|'), '内容流重建，截到第二轮', said(stream))
    await until('页面上第三条不见了', async () => ((await text()).includes(P3) ? undefined : true), 5_000)
    check(!(await api(`/sessions/${s.id}`)).live, '子进程停了')

    // 4. 页面上代码和对话一起退到第二条之前（这时没有子进程）
    await page.getByText(P2, { exact: true }).click()
    await page.getByRole('button', { name: '↶ 回退到这里' }).click()
    await page.getByRole('button', { name: '代码和对话都回退' }).click()
    await until('原文放回输入框', async () => ((await page.locator('textarea').inputValue()) === P2 ? true : undefined), 30_000)
    await shot('rewind-done')
    check(file('a.txt') === 'one', '现起的子进程也能还原，a.txt 回到 one', file('a.txt'))
    check(said(stream).join('|') === P1, '截到第一轮', said(stream))

    // 5. 接着发：从截断处分叉
    await api(`/sessions/${s.id}/messages`, { text: P4 })
    await idle(s.id)
    check(file('b.txt') === 'four', '新的一轮照常干活', file('b.txt'))
    const chain = (await getSessionMessages(s.id))
      .filter((m) => m.type === 'user')
      .map((m) => (m.message as { content: unknown }).content)
      .filter((c): c is string => typeof c === 'string')
    check(chain.includes(P1) && chain.includes(P4) && !chain.includes(P2) && !chain.includes(P3), 'transcript 主链里没有回退掉的', chain)
    const u4 = inputs(stream).at(-1)!
    const pre4 = await api(`/sessions/${s.id}/rewind`, { uuid: u4.uuid, dryRun: true })
    check(pre4.files?.canRewind && pre4.files.filesChanged?.some((f: string) => f.endsWith('b.txt')), '新分支上的这条也留了底', pre4)

    // 6. 第一条之前：只还原代码
    await api(`/sessions/${s.id}/rewind`, { uuid: u1!.uuid, restore: 'code' })
    check(file('a.txt') === undefined && file('b.txt') === undefined, 'a.txt、b.txt 都没了', [file('a.txt'), file('b.txt')])
    check(said(stream).join('|') === [P1, P4].join('|'), '对话不动', said(stream))
  },
  { browser: true },
)
