// 状态栏（照搬 statusline）的数据：模型的上下文上限和 effort、主链最近一次用量、5h / 7d 额度。
// 口径照抄 CLI 拼 statusline 输入的代码（见 REFERENCE.md「statusline 照搬」）
import type { ModelUsage, Query, SDKAssistantMessage, SDKRateLimitInfo } from '@anthropic-ai/claude-agent-sdk'
import type { LastUsage, Quota } from '../shared/protocol'

// ---- 按模型记的：上下文上限、effort ----

interface ModelFacts {
  window?: number
  /** null：这个模型不带 effort（statusline 里不显示） */
  effort?: string | null
}

/**
 * 上下文上限是模型的属性，effort 是 Claude Code 按设置给这个模型定的，都按模型 id 记着：
 * 历史会话、终端会话没有子进程可问，用托管会话问到的
 */
const facts = new Map<string, ModelFacts>()
const factWatchers = new Set<() => void>()

export const modelFacts = (model: string | undefined) => (model ? facts.get(model) : undefined)

/** 有变化时通知（各会话要重新推状态） */
export function onFacts(fn: () => void): () => void {
  factWatchers.add(fn)
  return () => factWatchers.delete(fn)
}

function setFacts(model: string, patch: ModelFacts) {
  const old = facts.get(model) ?? {}
  if (Object.entries(patch).every(([k, v]) => old[k as keyof ModelFacts] === v)) return
  facts.set(model, { ...old, ...patch })
  for (const fn of factWatchers) fn()
}

/** result 里每个用到的模型（包括子代理的）都带着上下文上限。启动出错的 result 可能是空的，状态栏的事不能搅了会话 */
export function learnWindows(modelUsage: Record<string, ModelUsage> | undefined) {
  for (const [model, u] of Object.entries(modelUsage ?? {})) if (u?.contextWindow > 0) setFacts(model, { window: u.contextWindow })
}

/** 类型里没有、运行时有的方法：get_settings 控制请求。applied 是 Claude Code 实际要用的（init 的 effort 字段说明里提到它） */
type WithSettings = Query & { getSettings(): Promise<{ applied?: { effort?: string | null } }> }

/**
 * 问托管会话的子进程：上下文上限（getContextUsage 的 rawMaxTokens，实测与 modelUsage 的 contextWindow 一致；
 * 第一轮 result 之前就能知道），以及 effort（SDK 会话的 init 里没有 effort，实测）
 */
export async function learn(q: Query, model: string) {
  const [ctx, settings] = await Promise.all([q.getContextUsage({ detail: 'summary' }), (q as WithSettings).getSettings()])
  setFacts(model, { ...(ctx.rawMaxTokens > 0 && { window: ctx.rawMaxTokens }), effort: settings.applied?.effort ?? null })
}

// ---- 主链最近一次用量 ----

type RawUsage = {
  input_tokens?: number
  cache_creation_input_tokens?: number
  cache_read_input_tokens?: number
  cache_creation?: { ephemeral_1h_input_tokens?: number; ephemeral_5m_input_tokens?: number } | null
  iterations?: unknown
}

type Iteration = { type?: string; input_tokens?: number; cache_creation_input_tokens?: number; cache_read_input_tokens?: number }

/**
 * 一条 assistant 消息的输入侧用量，ttl 是这次请求写缓存的档位（没有细分时为空）。
 * 照抄 CLI：合成的消息（model 为 <synthetic>，中断、API 出错时补的）不算；usage 里有 iterations 的，取最后一次正常的请求
 */
export function readUsage(message: SDKAssistantMessage['message']): Omit<LastUsage, 'at' | 'ttl'> & { ttl?: number } | undefined {
  const u = (message as { usage?: RawUsage }).usage
  if (!u || message.model === '<synthetic>') return
  let { input_tokens: input = 0, cache_creation_input_tokens: cacheCreation = 0, cache_read_input_tokens: cacheRead = 0 } = u
  if (Array.isArray(u.iterations) && input + cacheCreation + cacheRead > 0) {
    const last = (u.iterations as Iteration[]).findLast((it) => it?.type !== 'advisor_message' && it?.type !== 'compaction')
    if ((last?.type === 'message' || last?.type === 'fallback_message') && typeof last.input_tokens === 'number') {
      input = last.input_tokens
      cacheCreation = last.cache_creation_input_tokens ?? 0
      cacheRead = last.cache_read_input_tokens ?? 0
    }
  }
  const c = u.cache_creation
  const ttl = (c?.ephemeral_1h_input_tokens ?? 0) > 0 ? 3600 : (c?.ephemeral_5m_input_tokens ?? 0) > 0 ? 300 : undefined
  return { input, cacheCreation, cacheRead, ttl }
}

/**
 * 一个会话主链最近一次用量。同一次 API 调用的几帧（每块一帧）用量相同，时间按第一帧算
 * （同 statusline 脚本：用量变了才重设倒计时）；缓存档位沿用最近一次看到的，一次都没有就按 1h
 */
export class UsageTracker {
  last?: LastUsage
  private ttl = 3600

  update(message: SDKAssistantMessage['message'], at: number) {
    const u = readUsage(message)
    if (!u) return
    if (u.ttl) this.ttl = u.ttl
    const old = this.last
    if (old && old.input === u.input && old.cacheCreation === u.cacheCreation && old.cacheRead === u.cacheRead) return
    this.last = { input: u.input, cacheCreation: u.cacheCreation, cacheRead: u.cacheRead, at, ttl: this.ttl }
  }
}

// ---- 5h / 7d 额度 ----

const WINDOWS = ['five_hour', 'seven_day'] as const

/** statusline 的 used_percentage：CLI 把 0–1 的小数乘 100、保留一位 */
const pct = (utilization: number) => Math.round(utilization * 1000) / 10

/** rate_limit_event：utilization 是 0–1，resetsAt 是 epoch 秒；unifiedWindows（类型里没写）一次带两个窗口 */
export function quotaFromEvent(info: SDKRateLimitInfo): Quota {
  const unified = (info as { unifiedWindows?: Record<string, { utilization?: number; resetsAt?: number } | undefined> }).unifiedWindows
  const q: Quota = {}
  for (const w of WINDOWS) {
    const src = unified?.[w] ?? (info.rateLimitType === w ? info : undefined)
    if (typeof src?.utilization === 'number' && typeof src.resetsAt === 'number') q[w] = { used: pct(src.utilization), resetsAt: src.resetsAt }
  }
  return q
}

/**
 * 额度，全账号一份，只来自托管会话里的 rate_limit_event（每次 API 响应都带）。
 * 不用 usage 接口：它要另外请求 Anthropic，设了 CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC 时不发，没请求过的进程里就是 null（见 REFERENCE.md）
 */
export class QuotaTracker {
  current: Quota | null = null
  private watchers = new Set<(q: Quota) => void>()

  watch(fn: (q: Quota) => void): () => void {
    this.watchers.add(fn)
    return () => this.watchers.delete(fn)
  }

  fromEvent(info: SDKRateLimitInfo) {
    const q = quotaFromEvent(info)
    if (!q.five_hour && !q.seven_day) return
    const next = { ...this.current, ...q }
    if (JSON.stringify(next) === JSON.stringify(this.current)) return
    this.current = next
    for (const fn of this.watchers) fn(next)
  }
}

export const quota = new QuotaTracker()
