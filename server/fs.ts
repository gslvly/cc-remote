// 选目录用：只看目录、只在 roots 内。不是文件浏览器，不读文件内容（除了 .git/HEAD 取分支）
import { readdir, readFile, realpath, stat } from 'node:fs/promises'
import { basename, isAbsolute, join, resolve } from 'node:path'
import type { DirEntry } from '../shared/protocol'

/** real 必须是真实路径（realpath 过），roots 也是 */
export const inRoots = (real: string, roots: string[]) =>
  roots.some((r) => r === '/' || real === r || real.startsWith(r + '/'))

const isDir = (p: string) => stat(p).then((s) => s.isDirectory(), () => false)

export type DirCheck = { ok: true; path: string } | { ok: false; status: 400 | 403 | 404; error: string }

/** 把前端给的路径解析成真实路径（跟随符号链接、消掉 ..），确认是目录且在 roots 内 */
export async function checkDir(p: unknown, roots: string[]): Promise<DirCheck> {
  if (typeof p !== 'string' || !isAbsolute(p)) return { ok: false, status: 400, error: '要给绝对路径' }
  const real = await realpath(p).catch(() => '')
  if (!real || !(await isDir(real))) return { ok: false, status: 404, error: '目录不存在' }
  if (!inRoots(real, roots)) return { ok: false, status: 403, error: '目录不在 roots 内（见 ~/.cc-remote/config.json）' }
  return { ok: true, path: real }
}

/** git 仓库的当前分支；detached HEAD 时返回短 commit。worktree / submodule 的 .git 是个文件，指向真正的 gitdir */
export async function gitBranch(dir: string): Promise<string | undefined> {
  try {
    let gitdir = join(dir, '.git')
    const s = await stat(gitdir)
    if (s.isFile()) {
      const m = (await readFile(gitdir, 'utf8')).match(/^gitdir:\s*(.+)$/m)
      if (!m) return
      gitdir = resolve(dir, m[1]!.trim())
    } else if (!s.isDirectory()) return
    const head = (await readFile(join(gitdir, 'HEAD'), 'utf8')).trim()
    const ref = head.match(/^ref:\s*refs\/heads\/(.+)$/)
    if (ref) return ref[1]
    if (/^[0-9a-f]{40,64}$/.test(head)) return head.slice(0, 7)
  } catch {
    return
  }
}

export const dirEntry = async (path: string, name = basename(path)): Promise<DirEntry> => ({
  name,
  path,
  branch: await gitBranch(path),
})

const byName = (a: DirEntry, b: DirEntry) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' })

/** 只列子目录；点开头的算隐藏目录。符号链接指向的目录也要在 roots 内才列 */
export async function listDirs(dir: string, roots: string[], hidden: boolean): Promise<DirEntry[]> {
  const items = await readdir(dir, { withFileTypes: true })
  const entries = await Promise.all(
    items.map(async (d) => {
      if (!hidden && d.name.startsWith('.')) return
      const path = join(dir, d.name)
      if (d.isSymbolicLink()) {
        const real = await realpath(path).catch(() => '')
        if (!real || !inRoots(real, roots) || !(await isDir(real))) return
      } else if (!d.isDirectory()) return
      return dirEntry(path, d.name)
    }),
  )
  return entries.filter((e) => e !== undefined).sort(byName)
}
