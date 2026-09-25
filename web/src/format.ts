import type { FsList, PermissionMode, SwitchableMode } from '../../shared/protocol'

/** 手机上能切的模式，顺序同终端 Shift+Tab 的轮换 */
export const MODES: SwitchableMode[] = ['default', 'acceptEdits', 'plan']

export const MODE_LABEL: Record<PermissionMode, string> = {
  default: '默认',
  acceptEdits: '接受编辑',
  plan: '规划',
  bypassPermissions: '跳过审批',
  auto: '自动',
  dontAsk: '不询问',
}

/** 服务端给的是它那台机器上的路径：Windows 的（C:\… 或 \\server\…）用 \，其他用 / */
export const sepOf = (p: string) => (/^([A-Za-z]:|\\\\)/.test(p) ? '\\' : '/')

export function basename(p: string): string {
  const sep = sepOf(p)
  return p.split(sep).filter(Boolean).pop() || p
}

/** 家目录（/Users/x、/home/x、C:\Users\x）缩写成 ~，路径太长时只留后几段 */
export function shortPath(p: string, keep = 3): string {
  const sep = sepOf(p)
  const s = p.replace(/^(\/Users\/[^/]+|\/home\/[^/]+|[A-Za-z]:\\Users\\[^\\]+)/i, '~')
  const parts = s.split(sep)
  return parts.length > keep + 1 ? `…${sep}${parts.slice(-keep).join(sep)}` : s
}

/** root 显示成 ~ 或完整路径 */
export const rootLabel = (p: string) => shortPath(p, Infinity)

/** 选目录的面包屑：[全部（多个 root 时）] / root / 子目录…。root 可能以分隔符结尾（/、C:\） */
export function crumbs(list: FsList): { label: string; path: string | null }[] {
  const out: { label: string; path: string | null }[] = list.roots.length > 1 ? [{ label: '全部', path: null }] : []
  const path = list.path
  if (!path) return out
  const sep = sepOf(path)
  const join = (dir: string, seg: string) => (dir.endsWith(sep) ? dir + seg : dir + sep + seg)
  const root = list.roots
    .filter((r) => path === r || path.startsWith(join(r, '')))
    .sort((a, b) => b.length - a.length)[0]
  if (!root) return [...out, { label: path, path }]
  out.push({ label: rootLabel(root), path: root })
  let cur = root
  for (const seg of path.slice(root.length).split(sep).filter(Boolean)) {
    cur = join(cur, seg)
    out.push({ label: seg, path: cur })
  }
  return out
}

export function ago(ms: number): string {
  const s = Math.max(0, (Date.now() - ms) / 1000)
  if (s < 60) return '刚刚'
  if (s < 3600) return `${Math.floor(s / 60)} 分钟前`
  if (s < 86400) return `${Math.floor(s / 3600)} 小时前`
  if (s < 86400 * 30) return `${Math.floor(s / 86400)} 天前`
  return new Date(ms).toLocaleDateString()
}

export function duration(ms: number): string {
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`
  const m = Math.floor(ms / 60_000)
  return `${m}m${Math.round((ms % 60_000) / 1000)}s`
}

export const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e))
