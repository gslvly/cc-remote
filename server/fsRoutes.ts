// /api/fs/*：选目录时列子目录和文件、新建文件夹、删文件夹，看文件、下载文件，都限定在 roots 内
import { Hono } from 'hono'
import type { DirEntry, FileEntry, FsList, MkdirBody, RmdirBody } from '../shared/protocol'
import { fileHeaders } from './files'
import { checkDir, checkFile, dirEntry, gitBranch, listDirs, listFiles, makeDir, removeDir } from './fs'

/** busy(dir)：有会话正在 dir 里（或它下面）跑，这时不让删 */
export function fsRoutes(roots: string[], busy: (dir: string) => boolean) {
  const fs = new Hono()

  // 列子目录，带 files=1 时也列文件。不给 path 时：只有一个 root 就列它，有多个就列出各个 root
  fs.get('/ls', async (c) => {
    const hidden = c.req.query('hidden') === '1'
    const withFiles = c.req.query('files') === '1'
    const path = c.req.query('path') || (roots.length === 1 ? roots[0] : undefined)
    if (!path) return c.json<FsList>({ roots, path: null, entries: await Promise.all(roots.map((r) => dirEntry(r, r))) })

    const dir = await checkDir(path, roots)
    if (!dir.ok) return c.json({ error: dir.error }, dir.status)
    let entries: DirEntry[]
    let files: FileEntry[] | undefined
    try {
      ;[entries, files] = await Promise.all([
        listDirs(dir.path, roots, hidden),
        withFiles ? listFiles(dir.path, roots, hidden) : undefined,
      ])
    } catch (e) {
      // macOS 隐私保护的目录（Library 下的一些）、没权限的目录
      return c.json({ error: `读不了这个目录：${(e as NodeJS.ErrnoException).code ?? e}` }, 403)
    }
    return c.json<FsList>({ roots, path: dir.path, branch: await gitBranch(dir.path), entries, files })
  })

  // 看文件前先取大小、修改时间；不存在、不在 roots 内在这里就报出来
  fs.get('/stat', async (c) => {
    const f = await checkFile(c.req.query('path'), roots)
    if (!f.ok) return c.json({ error: f.error }, f.status)
    return c.json<FileEntry>(f.file)
  })

  // 文件本身，dl=1 是下载。Range（拖视频进度、只取文本开头）Bun.serve 自己处理
  fs.get('/file', async (c) => {
    const f = await checkFile(c.req.query('path'), roots)
    if (!f.ok) return c.json({ error: f.error }, f.status)
    const headers = fileHeaders(f.file, c.req.query('dl') === '1')
    if (c.req.header('if-none-match') === headers.ETag) return c.body(null, 304, headers)
    return new Response(Bun.file(f.file.path), { headers })
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
