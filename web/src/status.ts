// 状态栏的数据：项目同 ~/.claude/statusline-command.sh（模型、上下文、缓存、5h / 7d），数值口径照抄 CLI 和脚本，显示为手机重排
import type { LastUsage, QuotaWindow, SessionInfo } from '../../shared/protocol'

/**
 * 模型名：claude-opus-5-5 → Opus 5.5，claude-haiku-4-5-20251001 → Haiku 4.5。
 * statusline 的 display_name 来自 CLI 内置的模型表，SDK 拿不到（supportedModels 给的是 Opus、Default 这类选项名），按 id 拼出同样的写法
 */
export function modelName(id: string): string {
  const [family = id, ...version] = id
    .replace(/^claude-/, '')
    .replace(/(-\d{8})?(\[.*\])?$/, '')
    .split('-')
  return [family[0]!.toUpperCase() + family.slice(1), version.join('.')].filter(Boolean).join(' ')
}

/** 上下文上限：1M / 200k */
export function fmtSize(n: number): string {
  return n >= 1_000_000 ? `${+(n / 1_000_000).toFixed(1)}M` : `${Math.floor(n / 1000)}k`
}

/** 模型 · 上下文上限 · effort，如 Opus 5.5 · 1M · xhigh（还不知道的项不显示） */
export function modelLabel(i: SessionInfo): string {
  return [i.model && modelName(i.model), i.contextWindow && fmtSize(i.contextWindow), i.effort].filter(Boolean).join(' · ')
}

const sec = (ms: number) => Math.floor(ms / 1000)

/** 距重置：1d2h / 3h05m / 12m，过了就是「即将重置」。resetsAt 是 epoch 秒 */
export function fmtRemaining(resetsAt: number, now: number): string {
  const diff = Math.floor(resetsAt) - sec(now)
  if (diff <= 0) return '即将重置'
  const d = Math.floor(diff / 86400)
  const h = Math.floor((diff % 86400) / 3600)
  const m = Math.floor((diff % 3600) / 60)
  if (d > 0) return `${d}d${h}h`
  if (h > 0) return `${h}h${String(m).padStart(2, '0')}m`
  return `${m}m`
}

const total = (u: LastUsage) => u.input + u.cacheCreation + u.cacheRead

/** 上下文占用：pct 按 CLI 的算法（输入侧总量 ÷ 上限，四舍五入、夹在 0–100），不知道上限时没有；k 是输入侧总量 */
export function ctxParts(u: LastUsage | undefined, window: number | undefined): { pct?: number; k: number } {
  const n = u ? total(u) : 0
  return { pct: u && window ? Math.min(100, Math.max(0, Math.round((n / window) * 100))) : undefined, k: Math.floor(n / 1000) }
}

/**
 * 缓存：hit 是最近一次请求有多少输入来自缓存（向下取整，不到 100 不显示 100）；
 * left 是距缓存过期还剩多久（纯分钟，不到一分钟按秒），过期了为空。没有用量时返回 undefined
 */
export function cacheParts(u: LastUsage | undefined, now: number): { hit: number; left?: string } | undefined {
  const n = u ? total(u) : 0
  if (!u || n <= 0) return
  const rem = sec(u.at) + u.ttl - sec(now)
  return { hit: Math.floor((u.cacheRead * 100) / n), left: rem <= 0 ? undefined : rem >= 60 ? `${Math.floor(rem / 60)}m` : `${rem}s` }
}

/** 额度窗口：剩余百分比（100 − 已用，取整）和距重置 */
export function quotaParts(w: QuotaWindow | undefined, now: number): { left: number; resets: string } | undefined {
  if (!w) return
  return { left: Math.round(100 - w.used), resets: fmtRemaining(w.resetsAt, now) }
}
