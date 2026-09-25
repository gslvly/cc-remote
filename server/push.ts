// 推送到手机（Bark / ntfy）：待批准、一轮结束、额度被拒，点开进入那个会话。
// 只在没有概览流连着时推：手机切后台、锁屏时前端会断开（见 web/src/sse.ts）；在前台时由应用内横幅和状态点提醒
import type { SDKRateLimitInfo, SDKResultMessage } from '@anthropic-ai/claude-agent-sdk'
import type { PermissionRequest } from '../shared/protocol'
import type { PushConfig } from './config'

export interface Notice {
  title: string
  body: string
  /** 点开进入的会话 */
  session: string
  /** 待批准：Bark 发时效性通知、ntfy 用高优先级，专注模式下也会提醒 */
  urgent?: boolean
}

/** 推送里要用到的会话字段 */
interface Target {
  id: string
  title: string
}

/** 发给推送服务的请求，格式实测过（见 REFERENCE.md）。中文标题只能放 JSON 里，放 header 要另外编码 */
export function pushRequests(cfg: PushConfig, n: Notice, link: string): { url: string; init: RequestInit }[] {
  const out: { url: string; init: RequestInit }[] = []
  const json = (url: string, body: object, headers: Record<string, string> = {}) =>
    out.push({ url, init: { method: 'POST', headers: { 'Content-Type': 'application/json; charset=utf-8', ...headers }, body: JSON.stringify(body) } })
  const { bark, ntfy } = cfg
  if (bark) {
    const server = (bark.server || 'https://api.day.app').replace(/\/+$/, '')
    json(`${server}/push`, { device_key: bark.key, title: n.title, body: n.body, url: link, group: 'cc-remote', ...(n.urgent && { level: 'timeSensitive' }) })
  }
  if (ntfy) {
    const server = (ntfy.server || 'https://ntfy.sh').replace(/\/+$/, '')
    const auth: Record<string, string> = ntfy.token ? { Authorization: `Bearer ${ntfy.token}` } : {}
    json(server, { topic: ntfy.topic, title: n.title, message: n.body, click: link, ...(n.urgent && { priority: 4 }) }, auth)
  }
  return out
}

/** 压成一行，太长截断 */
const clip = (s: string | undefined, max: number) => {
  const t = (s ?? '').replace(/\s+/g, ' ').trim()
  return t.length > max ? `${t.slice(0, max - 1)}…` : t
}
const heading = (kind: string, s: Target) => `${kind} · ${clip(s.title, 40)}`

/**
 * 待批准。title 是现成的整句提示；Bash 请求没有 title，description 是 Claude 自己的转述，
 * 批不批要看命令本身，所以有命令就放命令
 */
export function approvalNotice(s: Target, req: PermissionRequest): Notice {
  const { toolName, input } = req
  const what = typeof input.command === 'string' ? input.command : req.description
  const [kind, body] =
    toolName === 'AskUserQuestion'
      ? ['等你回答', (input.questions as { question?: string }[] | undefined)?.[0]?.question]
      : toolName === 'ExitPlanMode'
        ? ['计划待批准', String(input.plan ?? '').replace(/^[#\s]+/, '')]
        : ['待批准', req.title || [req.displayName || toolName, what].filter(Boolean).join('：')]
  return { session: s.id, title: heading(kind, s), body: clip(body, 120), urgent: true }
}

/** 一轮结束：成功时是最后一段回复；出错时 success 的 result 是错误文字，其他 subtype 看 errors */
export function doneNotice(s: Target, r: SDKResultMessage): Notice {
  const body = r.subtype === 'success' ? r.result : r.errors?.join('；') || r.subtype
  return { session: s.id, title: heading(r.is_error ? '出错' : '完成', s), body: clip(body, 120) }
}

/** 额度被拒。有超额（overage）顶上的请求照样过了，不算（没碰到过真的被拒，见 REFERENCE.md） */
export const quotaRejected = (info: SDKRateLimitInfo) => info.status === 'rejected' && !info.isUsingOverage

export function quotaNotice(s: Target, info: SDKRateLimitInfo): Notice {
  const t = info.rateLimitType
  const name = t === 'five_hour' ? '5 小时' : t?.startsWith('seven_day') ? '7 天' : ''
  const resets = info.resetsAt
    ? `，${new Date(info.resetsAt * 1000).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false })} 重置`
    : ''
  return { session: s.id, title: heading('额度用完', s), body: `${name}额度用完了${resets}` }
}

export class Pusher {
  private cfg: PushConfig = {}
  private base = ''
  /** 连着的概览流 */
  private viewers = 0
  /** 这一轮已经推过额度被拒的会话：随后那个出错的 result 就不再推 */
  private limited = new Set<string>()

  configure(cfg: PushConfig | undefined, publicUrl: string) {
    this.cfg = cfg ?? {}
    this.base = publicUrl.replace(/\/+$/, '')
  }

  /** 概览流连上时调用，返回断开时调用的 */
  view(): () => void {
    this.viewers++
    let done = false
    return () => {
      if (!done) this.viewers--
      done = true
    }
  }

  approval(s: Target, req: PermissionRequest) {
    this.notify(approvalNotice(s, req))
  }

  /** 一轮结束（排队的也跑完了） */
  done(s: Target, r: SDKResultMessage) {
    if (this.limited.delete(s.id)) return
    this.notify(doneNotice(s, r))
  }

  rateLimit(s: Target, info: SDKRateLimitInfo) {
    if (!quotaRejected(info) || this.limited.has(s.id)) return
    this.limited.add(s.id)
    this.notify(quotaNotice(s, info))
  }

  private notify(n: Notice) {
    if (this.viewers > 0) return
    for (const r of pushRequests(this.cfg, n, `${this.base}/#/s/${n.session}`)) void this.send(r.url, r.init)
  }

  private async send(url: string, init: RequestInit) {
    const host = new URL(url).host
    try {
      const res = await fetch(url, { ...init, signal: AbortSignal.timeout(10_000) })
      if (!res.ok) console.warn(`[push] ${host} 返回 ${res.status}：${(await res.text()).slice(0, 200)}`)
    } catch (e) {
      console.warn(`[push] 发到 ${host} 失败：${e instanceof Error ? e.message : e}`)
    }
  }
}

export const pusher = new Pusher()
