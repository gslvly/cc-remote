// 审批：canUseTool 的请求 → 发给手机的；手机上的决定 → 回给 SDK 的结果
import type { CanUseTool, PermissionResult, PermissionUpdate } from '@anthropic-ai/claude-agent-sdk'
import type { PermissionDecisionBody, PermissionRequest } from '../shared/protocol'
import { truncateDeep } from './slim'

/** canUseTool 的参数 → 发给手机的审批请求（input 截断过，回给 SDK 时用原件） */
export function permissionRequest(...[toolName, input, opts]: Parameters<CanUseTool>): PermissionRequest {
  return {
    id: opts.requestId || crypto.randomUUID(),
    toolName,
    toolUseId: opts.toolUseID,
    agentId: opts.agentID,
    input: truncateDeep(input) as Record<string, unknown>,
    title: opts.title,
    displayName: opts.displayName,
    description: opts.description,
    decisionReason: opts.decisionReason,
    blockedPath: opts.blockedPath,
    defaultToNo: opts.defaultToNo,
    suggestions: opts.suggestions,
    suppressAlwaysAllowRule: opts.suppressAlwaysAllowRule,
  }
}

/**
 * 还在等手机决定的审批。canUseTool 交给 SDK；发出请求、请求作废经回调记进会话的事件缓冲。
 * requested 返回 permission_request 事件的 seq
 */
export class Approvals {
  private map = new Map<string, Pending>()

  constructor(private on: { requested: (req: PermissionRequest) => number; cancelled: (id: string) => void }) {}

  get size() {
    return this.map.size
  }

  /** 还在等的请求事件的 seq：只发最近一段时要包含进去，不然手机上弹不出审批 */
  seqs() {
    return [...this.map.values()].map((p) => p.seq)
  }

  canUseTool: CanUseTool = (toolName, input, opts) =>
    new Promise<PermissionResult>((resolve) => {
      const req = permissionRequest(toolName, input, opts)
      const p: Pending = { req, input, resolve, seq: 0 }
      this.map.set(req.id, p)
      p.seq = this.on.requested(req)
      opts.signal.addEventListener('abort', () => this.cancel(req.id, { behavior: 'deny', message: 'Aborted.' }))
    })

  /** 手机上的决定回给 SDK；请求已处理或已失效返回 false */
  decide(id: string, d: PermissionDecisionBody): boolean {
    const p = this.map.get(id)
    if (!p) return false
    this.map.delete(id)
    p.resolve(permissionResult(p, d))
    return true
  }

  /** 全部作废：中断、子进程退出 */
  cancelAll(result: PermissionResult) {
    for (const id of [...this.map.keys()]) this.cancel(id, result)
  }

  private cancel(id: string, result: PermissionResult) {
    const p = this.map.get(id)
    if (!p) return
    this.map.delete(id)
    p.resolve(result)
    this.on.cancelled(id)
  }
}

/** 一个还在等手机决定的 canUseTool 调用 */
interface Pending {
  req: PermissionRequest
  input: Record<string, unknown>
  resolve: (r: PermissionResult) => void
  /** permission_request 事件的 seq：只发最近一段时，要把还在等批准的请求包含进去 */
  seq: number
}

// 拒绝时回给 Claude 的话，照抄 CLI 在终端里用的
const REJECTED =
  "The user doesn't want to proceed with this tool use. The tool use was rejected (eg. if it was a file edit, the new_string was NOT written to the file)."

/** 手机上的决定 → 回给 SDK 的结果 */
export function permissionResult(p: Pick<Pending, 'req' | 'input'>, d: PermissionDecisionBody): PermissionResult {
  if (d.behavior === 'deny') {
    // 附了话：转给 Claude，这一轮接着跑。没附：停下这一轮，等下一句（终端里选 No 也是这样）
    const said = d.message?.trim()
    return said
      ? { behavior: 'deny', message: `${REJECTED} To tell you how to proceed, the user said:\n${said}` }
      : { behavior: 'deny', message: `${REJECTED} STOP what you are doing and wait for the user to tell you how to proceed.`, interrupt: true }
  }
  const updates: PermissionUpdate[] = []
  // 「本会话都允许」：CLI 给的建议规则原样用，只是不写进 settings 文件
  if (d.always && !p.req.suppressAlwaysAllowRule)
    for (const s of p.req.suggestions ?? []) updates.push({ ...s, destination: 'session' })
  if (d.mode) updates.push({ type: 'setMode', mode: d.mode, destination: 'session' })
  // input 用原件（req.input 截断过）
  const input = d.answers ? { ...p.input, answers: d.answers, ...(d.annotations && { annotations: d.annotations }) } : p.input
  return { behavior: 'allow', updatedInput: input, ...(updates.length && { updatedPermissions: updates }) }
}
