// 删会话
//  1. 正在跑的：先中断、等子进程退出再删；transcript、按 id 建的目录都没了，过一会也不会被退出前的写入补回来；
//     看着的收到 deleted，之后 404，概览里也没了
//  2. 终端里开着的不删（409）
//  3. 页面：目录页「编辑」→「删除」，确认后那条消失，刷新后也没有；正看着它的页面显示会话不存在
import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { CLAUDE_DIR } from '../../server/config'
import { api, check, events, run, sleep, terminal, testDir, text, until } from './harness'

const idle = (id: string) => until('这一轮结束', async () => (await api(`/sessions/${id}`)).state === 'idle', 120_000)
const status = (p: Promise<unknown>) => p.then(() => 200, (e) => e.status as number)

/** 这个会话在磁盘上留下的：transcript、子代理目录、文件快照、会话环境 */
function leftovers(dir: string, id: string) {
  const project = join(CLAUDE_DIR, 'projects', dir.replace(/[^a-zA-Z0-9]/g, '-'))
  const paths = [join(project, `${id}.jsonl`), join(project, id), join(CLAUDE_DIR, 'file-history', id), join(CLAUDE_DIR, 'session-env', id)]
  return paths.filter(existsSync).map((p) => p.replace(CLAUDE_DIR, '~/.claude'))
}

await run(
  async ({ page }) => {
    const dir = testDir('delete')

    // 1. 正在跑的
    const s = await api('/sessions', { cwd: dir, prompt: 'Count from 1 to 1500, one number per line, nothing else.' })
    await until('跑起来', async () => (await api(`/sessions/${s.id}`)).state === 'running', 30_000)
    await sleep(1500)
    check(leftovers(dir, s.id).length > 0, '删之前磁盘上有东西', leftovers(dir, s.id))
    const ev = events(s.id)
    await sleep(500)
    check((await api(`/sessions/${s.id}`)).state === 'running', '删的时候还在跑')
    const t0 = Date.now()
    await api(`/sessions/${s.id}/delete`, {})
    console.log(`  删除用时 ${Date.now() - t0}ms`)
    check(leftovers(dir, s.id).length === 0, '删干净了', leftovers(dir, s.id))
    await until('收到 deleted', () => ev.lines().includes('deleted'), 5000)
    check((await api('/sessions')).every((x: { id: string }) => x.id !== s.id), '概览里没了')
    check((await status(api(`/sessions/${s.id}`))) === 404, '再打开是 404')
    const procs = Bun.spawnSync(['pgrep', '-f', s.id]).stdout.toString().trim()
    check(!procs, '子进程退出了', procs)
    // SDK 关子进程时 2 秒后 SIGTERM、再 5 秒 SIGKILL，等过这段
    await sleep(8000)
    check(leftovers(dir, s.id).length === 0, '过一会也没被补回来', leftovers(dir, s.id))
    check((await status(api(`/sessions/${s.id}/delete`, {}))) === 404, '再删是 404')
    ev.close()

    // 2. 终端里开着的
    const term = terminal(dir, 'Use the Bash tool to run `sleep 20`, then reply with just: done', '--allowedTools=Bash')
    const t = await until('终端会话出现在概览里', async () =>
      (await api('/sessions')).find((x: any) => x.cwd === dir && x.terminal === 'running'),
    )
    check((await status(api(`/sessions/${t.id}/delete`, {}))) === 409, '终端里开着的不删')
    check(leftovers(dir, t.id).length > 0, 'transcript 还在')
    term.proc.kill()
    await term.exited

    // 3. 页面
    const a = await api('/sessions', { cwd: dir, prompt: 'Reply with just: alpha' })
    const b = await api('/sessions', { cwd: dir, prompt: 'Reply with just: beta' })
    await idle(a.id)
    await idle(b.id)
    const dialogs: string[] = []
    page.on('dialog', (d) => {
      dialogs.push(d.message())
      void d.accept()
    })
    await page.evaluate((p) => (location.hash = `#/dir?path=${encodeURIComponent(p)}`), dir)
    await until('历史会话列出来', async () => (await text()).includes('Reply with just: alpha'), 10_000)
    await page.getByRole('button', { name: '编辑' }).click()
    const row = page.locator('li', { hasText: 'Reply with just: alpha' })
    await row.getByRole('button', { name: '删除' }).click()
    await until('那条消失', async () => !(await text()).includes('Reply with just: alpha'), 15_000)
    check(dialogs[0]?.includes('找不回来'), '删之前确认', dialogs)
    check((await text()).includes('Reply with just: beta'), '别的还在')
    check(leftovers(dir, a.id).length === 0, '页面上删的也删干净了', leftovers(dir, a.id))
    await page.reload()
    await until('刷新后列出来', async () => (await text()).includes('Reply with just: beta'), 10_000)
    check(!(await text()).includes('Reply with just: alpha'), '刷新后也没有')

    await page.evaluate((id) => (location.hash = `#/s/${id}`), b.id)
    await until('会话页打开', async () => (await text()).includes('beta'), 10_000)
    await api(`/sessions/${b.id}/delete`, {})
    await until('正看着的页面显示会话不存在', async () => (await text()).includes('会话不存在'), 5000)

    const rest = readdirSync(join(CLAUDE_DIR, 'projects', dir.replace(/[^a-zA-Z0-9]/g, '-'))).filter((f) => f.endsWith('.jsonl'))
    check(!rest.some((f) => f.startsWith(a.id) || f.startsWith(b.id) || f.startsWith(s.id)), '目录里只剩没删的', rest)
  },
  { browser: true },
)
