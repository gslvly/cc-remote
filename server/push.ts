// 推送到手机（Bark / ntfy / 网页推送）：待批准（含终端里的）、一轮结束、额度被拒，点开进入那个会话。
// 只在没有概览流连着时推：手机切后台、锁屏时前端会断开（见 web/src/sse.ts）；在前台时由应用内横幅和状态点提醒
import type { SDKRateLimitInfo, SDKResultMessage } from '@anthropic-ai/claude-agent-sdk'
import type { PermissionRequest } from '../shared/protocol'
import { type PendingTool, pendingTool } from './activity'
import type { PushConfig } from './config'
import type { Holder } from './terminal'
import type { WebPush } from './webpush'

/** 终端等人等了这么久还没处理才推：人在电脑前一般几秒内就批了 */
export const TERMINAL_WAIT_MS = 10_000

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

const str = (v: unknown) => (typeof v === 'string' ? v : undefined)

/**
 * 待批准。title 是现成的整句提示；Bash 请求没有 title，description 是 Claude 自己的转述，
 * 批不批要看命令本身，所以有命令就放命令。终端里的只有 transcript 里的工具名和参数，where 标出是终端
 */
export function approvalNotice(s: Target, req: Pick<PermissionRequest, 'toolName' | 'input' | 'title' | 'displayName' | 'description'>, where = ''): Notice {
  const { toolName, input } = req
  const what = str(input.command) ?? req.description ?? str(input.file_path) ?? str(input.url)
  const [kind, body] =
    toolName === 'AskUserQuestion'
      ? ['等你回答', (input.questions as { question?: string }[] | undefined)?.[0]?.question]
      : toolName === 'ExitPlanMode'
        ? ['计划待批准', String(input.plan ?? '').replace(/^[#\s]+/, '')]
        : ['待批准', req.title || [req.displayName || toolName, what].filter(Boolean).join('：')]
  return { session: s.id, title: heading(kind + where, s), body: clip(body, 120), urgent: true }
}

/** 终端里在等人，手机上批不了，提醒回电脑前。不是工具审批、transcript 里没找到是哪次调用，就只说在等 */
export function terminalNotice(s: Target, tool?: PendingTool): Notice {
  if (tool) return approvalNotice(s, { toolName: tool.name, input: tool.input }, '（终端）')
  return { session: s.id, title: heading('等你操作（终端）', s), body: '终端里在等你批准或回答', urgent: true }
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
  private web?: WebPush
  /** 连着的概览流 */
  private viewers = 0
  /** 这一轮已经推过额度被拒的会话：随后那个出错的 result 就不再推 */
  private limited = new Set<string>()
  /** 这次等待已经推过的终端会话：不在等了才清掉 */
  private waited = new Set<string>()

  /** web 是网页推送的订阅表；测试里不传，免得读到本机真实的订阅 */
  configure(cfg: PushConfig | undefined, publicUrl: string, web?: WebPush) {
    this.cfg = cfg ?? {}
    this.web = web
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

  /**
   * 终端里的会话，登记表每扫一遍调一次（h 是持有它的终端进程，见 Session.setHolder）。
   * 在等人、等了 TERMINAL_WAIT_MS 还没处理，推一次；dialog open 是终端里自己打开的 /config 之类，不算
   */
  terminal(s: Target & { cwd: string }, h: Holder | undefined): Promise<void> | undefined {
    if (h?.status !== 'waiting' || h.waitingFor === 'dialog open') return void this.waited.delete(s.id)
    if (this.waited.has(s.id) || Date.now() - h.updatedAt < TERMINAL_WAIT_MS) return
    this.waited.add(s.id)
    if (this.viewers > 0) return
    const tool = h.waitingFor === 'permission prompt' ? pendingTool(s.id, s.cwd).catch(() => undefined) : undefined
    return Promise.resolve(tool).then((t) => this.notify(terminalNotice(s, t)))
  }

  private notify(n: Notice) {
    if (this.viewers > 0) return
    for (const r of pushRequests(this.cfg, n, `${this.base}/#/s/${n.session}`)) void this.send(r.url, r.init)
    void this.webPush(n)
  }

  /** 推送服务回 404 / 410：设备退订了、清了网站数据、卸了 PWA，订阅作废 */
  private async webPush(n: Notice) {
    const web = this.web
    if (!web) return
    try {
      for (const r of await web.requests(n))
        void this.send(r.url, r.init).then((status) => (status === 404 || status === 410) && web.remove(r.url))
    } catch (e) {
      console.warn(`[push] 网页推送出错：${e instanceof Error ? e.message : e}`)
    }
  }

  /** 返回 HTTP 状态，没发出去时没有 */
  private async send(url: string, init: RequestInit): Promise<number | undefined> {
    const host = new URL(url).host
    try {
      const res = await fetch(url, { ...init, signal: AbortSignal.timeout(10_000) })
      if (!res.ok) console.warn(`[push] ${host} 返回 ${res.status}：${(await res.text()).slice(0, 200)}`)
      return res.status
    } catch (e) {
      console.warn(`[push] 发到 ${host} 失败：${e instanceof Error ? e.message : e}`)
    }
  }
}

export const pusher = new Pusher()
