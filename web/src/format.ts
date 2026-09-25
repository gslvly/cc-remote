import type { PermissionMode, SwitchableMode } from '../../shared/protocol'

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

export function basename(p: string): string {
  return p.replace(/\/+$/, '').split('/').pop() || p
}

/** 家目录缩写成 ~，路径太长时只留后几段 */
export function shortPath(p: string, keep = 3): string {
  const s = p.replace(/^\/Users\/[^/]+/, '~')
  const parts = s.split('/')
  return parts.length > keep + 1 ? `…/${parts.slice(-keep).join('/')}` : s
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
