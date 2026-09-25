// 服务端与前端共用的协议类型。只放类型，不放运行时代码。
import type { PermissionMode, PermissionUpdate, SDKMessage } from '@anthropic-ai/claude-agent-sdk'

export type { PermissionMode, PermissionUpdate, SDKMessage }

/**
 * 手机上能切的权限模式（终端 Shift+Tab 轮换的那几个）。auto 要看开关，不提供；
 * bypassPermissions 要启动时带 allowDangerouslySkipPermissions，不提供（见 REFERENCE.md）
 */
export type SwitchableMode = Extract<PermissionMode, 'default' | 'acceptEdits' | 'plan'>

/** 子进程被回收后仍是 idle：下次发消息时自动 resume */
export type SessionState = 'starting' | 'running' | 'requires_action' | 'idle'

export interface SessionInfo {
  id: string
  cwd: string
  title: string
  state: SessionState
  createdAt: number
  lastActivity: number
  pendingPermissions: number
  /** 有没有活着的 claude 子进程（空闲超时、到并发上限时会被回收） */
  live: boolean
  /** 最近一轮 init 报的模型和权限模式。内容流只发最近一段时可能不含 init，所以由服务端记着 */
  model?: string
  permissionMode?: PermissionMode
  /**
   * 终端里的会话（登记表 ~/.claude/sessions 里有进程持有它）：running = 终端进程还在，只读旁观；
   * exited = 手机看着的时候终端退出了，接管之后才能发消息（没人看时退出的就当历史会话）。没有这个字段就是托管会话 / 历史会话
   */
  terminal?: 'running' | 'exited'
  /** 状态栏：这个模型的上下文上限、effort（按模型记着，见 server/usage.ts）。还不知道就没有 */
  contextWindow?: number
  effort?: string
  /** 状态栏的 ctx、cache：主链最近一次 API 调用的用量 */
  usage?: LastUsage
}

/** 主链最近一次 API 调用的输入侧用量（statusline 的 current_usage） */
export interface LastUsage {
  input: number
  cacheCreation: number
  cacheRead: number
  /** 收到这次响应的时间（transcript 里读的用消息自己的时间），缓存倒计时从这里起算 */
  at: number
  /** 缓存档位（秒）：最近一次有细分的请求写的是 1h 还是 5m，都没有就按 1h（同 statusline 脚本） */
  ttl: number
}

/** 一个额度窗口：used 是已用的百分比（0–100），resetsAt 是重置时间（epoch 秒） */
export interface QuotaWindow {
  used: number
  resetsAt: number
}

/** 5h / 7d 额度，全账号一份，来自托管会话里的 rate_limit_event。概览流里有变化就推 `quota` 事件 */
export interface Quota {
  five_hour?: QuotaWindow
  seven_day?: QuotaWindow
}

export interface PermissionRequest {
  id: string
  toolName: string
  toolUseId?: string
  agentId?: string
  input: Record<string, unknown>
  title?: string
  displayName?: string
  description?: string
  decisionReason?: string
  blockedPath?: string
  defaultToNo?: boolean
  /** 「总是允许」要写的规则；手机上改成只对本会话生效 */
  suggestions?: PermissionUpdate[]
  /** 不要提供「总是允许」 */
  suppressAlwaysAllowRule?: boolean
}

/** 进入会话缓冲、可重放的事件 */
export type SessionEvent =
  /** uuid 就是这条消息在 transcript 里的 uuid（发给 SDK 时指定），与 transcript 对齐时靠它 */
  | { type: 'user_input'; text: string; uuid?: string }
  | { type: 'sdk'; msg: SDKMessage }
  | { type: 'permission_request'; req: PermissionRequest }
  | { type: 'permission_resolved'; id: string; behavior: 'allow' | 'deny' | 'cancelled' }
  | { type: 'error'; message: string }
  /** 灰色提示：本地命令的输出、对话已压缩等（transcript 里读出来的） */
  | { type: 'note'; text: string }

export interface EventEnvelope {
  seq: number
  at: number
  ev: SessionEvent
}

/**
 * 正在生成的那一块（主链的）。Messages API 按顺序逐块输出，同一时刻最多一块。
 * id 是 `消息 id:块序号`。这一块的完整 assistant 消息进缓冲时，快照随之作废（手机端收到那条事件就自己清掉）
 */
export type LiveBlock =
  | { kind: 'text'; id: string; text: string }
  /** 思考的正文不下发（增量里是空串），只有估算的 token 数 */
  | { kind: 'thinking'; id: string; tokens: number }
  /** 工具参数（JSON）还在生成：head 是开头一段，用来取摘要。参数是按字段整段下发的，不会逐字增长 */
  | { kind: 'tool'; id: string; name: string; head: string }

/**
 * 快照的变化，每 80ms 左右攒一批推一次，不进缓冲。
 * - `set`：换了一块，或思考的计数、工具参数变了（整块都发，量很小）；null 表示没有在生成的了
 * - `append`：文本追加。at 是追加前的长度，手机端按它去重（hello 里的快照可能已经含有这一段）
 */
export type LiveUpdate = { op: 'set'; block: LiveBlock | null } | { op: 'append'; id: string; at: number; text: string }

/**
 * 内容流 SSE（GET /api/sessions/:id/events?after=epoch:seq）：
 * - `hello`：连上后第一条。after（浏览器自动重连时是 Last-Event-ID 头，优先）的 epoch 对得上、差得不多时只补差量；
 *   否则 reset，只发最近约 200 条，更早的用 /history 分页取。之后是当前快照。
 *   中途也可能再来一条（reset，换了 epoch）：终端会话的 transcript 对不上了（压缩过、回退过），整段重建
 * - `ev`：新事件，SSE id 为 `epoch:seq`
 * - `live`：快照的变化（LiveUpdate）
 * - `state`：会话状态变化（不进缓冲）
 */
export interface StreamHello {
  epoch: string
  info: SessionInfo
  /** true：丢掉手里已有的，按 events 重建；false：events 是接在 after 后面的差量 */
  reset: boolean
  events: EventEnvelope[]
  /** reset 时，events 前面还有没有更早的 */
  more: boolean
  /** 补完 events 之后，正在生成的那一块 */
  live: LiveBlock | null
}

/** GET /api/sessions/:id/history?before=seq：seq 之前的一页 */
export interface HistoryPage {
  epoch: string
  events: EventEnvelope[]
  more: boolean
}

/**
 * 概览流 SSE（GET /api/overview）：`sessions` 事件，每次都是全部会话的完整列表（按最后活动时间倒序）；
 * `quota` 事件，额度（Quota）有变化时推，连上时有就先推一次
 */
export type OverviewSessions = SessionInfo[]

export interface RecentDir {
  cwd: string
  lastModified: number
  sessions: number
  lastTitle: string
}

/** 目录浏览里的一项（只列目录） */
export interface DirEntry {
  name: string
  /** 绝对路径 */
  path: string
  /** git 仓库的当前分支；detached HEAD 时是短 commit */
  branch?: string
}

/** GET /api/fs/ls?path=&hidden=1 */
export interface FsList {
  /** 配置里允许浏览的目录（真实路径） */
  roots: string[]
  /** 当前目录（真实路径）；配置了多个 root 又没指定 path 时为 null，这时 entries 就是各个 root */
  path: string | null
  branch?: string
  entries: DirEntry[]
}

/** 目录页里的一个历史会话（包括终端里开的）。在跑的状态看概览流 */
export interface DirSession {
  id: string
  title: string
  lastModified: number
  branch?: string
}

/** GET /api/dir/sessions?path=&offset= ：按最后修改时间倒序，一页 30 个 */
export interface DirSessions {
  sessions: DirSession[]
  more: boolean
}

/** GET /api/dir?path= ：目录页用 */
export interface DirInfo {
  /** 真实路径 */
  path: string
  branch?: string
  favorite: boolean
}

/** POST /api/favorites */
export interface FavoriteBody {
  path: string
  favorite: boolean
}

export interface CreateSessionBody {
  cwd: string
  prompt: string
  /** 不给就由 Claude Code 自己定（SDK 会话里是 default） */
  permissionMode?: SwitchableMode
}

export interface SendMessageBody {
  text: string
}

/** POST /api/sessions/:id/mode：子进程被回收了就记下，下次起子进程时带上 */
export interface SetModeBody {
  mode: SwitchableMode
}

/**
 * POST /api/sessions/:id/permissions/:reqId
 * - allow：`always` 把请求里的 suggestions 改成只对本会话生效；`answers` / `annotations` 是 AskUserQuestion 的回答
 *   （按问题原文索引，多选时 label 用逗号拼接）；`mode` 同时切权限模式（ExitPlanMode 批准后自动接受编辑）
 * - deny：带 message 就像终端里「No, and tell Claude what to do differently」，把话转给 Claude、这一轮接着跑；
 *   不带就停下这一轮，等下一句
 */
export type PermissionDecisionBody =
  | {
      behavior: 'allow'
      always?: boolean
      answers?: Record<string, string>
      annotations?: Record<string, { notes?: string; preview?: string }>
      mode?: SwitchableMode
    }
  | { behavior: 'deny'; message?: string }
