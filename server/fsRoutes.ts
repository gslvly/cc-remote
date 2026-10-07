// /api/fs/*：选目录时列子目录、新建文件夹、删文件夹，都限定在 roots 内
import { Hono } from 'hono'
import type { DirEntry, FsList, MkdirBody, RmdirBody } from '../shared/protocol'
import { checkDir, dirEntry, gitBranch, listDirs, makeDir, removeDir } from './fs'

/** busy(dir)：有会话正在 dir 里（或它下面）跑，这时不让删 */
export function fsRoutes(roots: string[], busy: (dir: string) => boolean) {
  const fs = new Hono()

  // 只列子目录。不给 path 时：只有一个 root 就列它，有多个就列出各个 root
  fs.get('/ls', async (c) => {
    const hidden = c.req.query('hidden') === '1'
    const path = c.req.query('path') || (roots.length === 1 ? roots[0] : undefined)
    if (!path) return c.json<FsList>({ roots, path: null, entries: await Promise.all(roots.map((r) => dirEntry(r, r))) })

    const dir = await checkDir(path, roots)
    if (!dir.ok) return c.json({ error: dir.error }, dir.status)
    let entries: DirEntry[]
    try {
      entries = await listDirs(dir.path, roots, hidden)
    } catch (e) {
      // macOS 隐私保护的目录（Library 下的一些）、没权限的目录
      return c.json({ error: `读不了这个目录：${(e as NodeJS.ErrnoException).code ?? e}` }, 403)
    }
    return c.json<FsList>({ roots, path: dir.path, branch: await gitBranch(dir.path), entries })
  })

  fs.post('/mkdir', async (c) => {
    const body = await c.req.json<MkdirBody>()
    const dir = await makeDir(body.parent, body.name, roots)
    if (!dir.ok) return c.json({ error: dir.error }, dir.status)
    return c.json<DirEntry>(await dirEntry(dir.path))
  })

  fs.post('/rm', async (c) => {
    const body = await c.req.json<RmdirBody>()
    const dir = await removeDir(body.path, roots, busy)
    if (!dir.ok) return c.json({ error: dir.error }, dir.status)
    return c.json({ ok: true })
  })

  return fs
}
