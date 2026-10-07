// 选目录用：只看目录、只在 roots 内。不是文件浏览器，不读文件内容（除了 .git/HEAD 取分支）
import { lstat, mkdir, readdir, readFile, realpath, rm, stat } from 'node:fs/promises'
import path, { basename, isAbsolute, join, resolve } from 'node:path'
import type { DirEntry } from '../shared/protocol'

/** child 是 dir 本身或在 dir 里面。用 relative 判断，Windows 的 \ 和盘符大小写也对；p 传 path.win32 是给单测用的 */
export function within(child: string, dir: string, p: typeof path = path) {
  const r = p.relative(dir, child)
  return r === '' || (r !== '..' && !r.startsWith('..' + p.sep) && !p.isAbsolute(r))
}

/** real 必须是真实路径（realpath 过），roots 也是 */
export const inRoots = (real: string, roots: string[], p: typeof path = path) => roots.some((r) => within(real, r, p))

const isDir = (p: string) => stat(p).then((s) => s.isDirectory(), () => false)

type Fail = { ok: false; status: 400 | 403 | 404 | 409; error: string }
export type DirCheck = { ok: true; path: string } | Fail
const fail = (status: Fail['status'], error: string): Fail => ({ ok: false, status, error })
const code = (e: unknown) => (e as NodeJS.ErrnoException).code ?? String(e)

/** 把前端给的路径解析成真实路径（跟随符号链接、消掉 ..），确认是目录且在 roots 内 */
export async function checkDir(p: unknown, roots: string[]): Promise<DirCheck> {
  if (typeof p !== 'string' || !isAbsolute(p)) return { ok: false, status: 400, error: '要给绝对路径' }
  const real = await realpath(p).catch(() => '')
  if (!real || !(await isDir(real))) return fail(404, '目录不存在')
  if (!inRoots(real, roots)) return fail(403, '目录不在 roots 内（见 ~/.cc-remote/config.json）')
  return { ok: true, path: real }
}

/** 在 parent 下建一层文件夹。名字不能带分隔符、不能是 . 和 ..；已有同名的就报错，不覆盖 */
export async function makeDir(parent: unknown, name: unknown, roots: string[]): Promise<DirCheck> {
  const dir = await checkDir(parent, roots)
  if (!dir.ok) return dir
  const n = typeof name === 'string' ? name.trim() : ''
  if (!n) return fail(400, '名字不能为空')
  if (n === '.' || n === '..' || /[/\\\0]/.test(n)) return fail(400, '名字里不能有 / 和 \\，也不能是 . 或 ..')
  const path = join(dir.path, n)
  try {
    await mkdir(path)
  } catch (e) {
    return code(e) === 'EEXIST' ? fail(409, '已有同名的文件或文件夹') : fail(403, `建不了：${code(e)}`)
  }
  return { ok: true, path }
}

/**
 * 删目录连同里面的所有东西。不删：配置的 root（及包含 root 的目录）、符号链接（免得删到链接指向的目录）、
 * busy 为真的（有会话正在里面跑）
 */
export async function removeDir(p: unknown, roots: string[], busy: (dir: string) => boolean): Promise<DirCheck> {
  const dir = await checkDir(p, roots)
  if (!dir.ok) return dir
  if (roots.some((r) => within(r, dir.path))) return fail(403, '这是 roots 里配置的目录，不能删')
  if ((await lstat(p as string)).isSymbolicLink()) return fail(400, '这是符号链接，不删')
  if (busy(dir.path)) return fail(409, '有会话正在这个目录里跑，先停掉再删')
  try {
    await rm(dir.path, { recursive: true })
  } catch (e) {
    return fail(403, `删不了：${code(e)}`)
  }
  return dir
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
