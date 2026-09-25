// 把会话事件归约成可渲染的条目。按不可变方式计算，store.ts 再按 key 合并进 store。
import type { EventEnvelope, PermissionRequest, SDKMessage } from '../../../shared/protocol'
import { duration } from '../format'

export type ToolStatus = 'running' | 'ok' | 'error'

export interface ToolItem {
  kind: 'tool'
  key: string
  id: string
  name: string
  input: Record<string, unknown>
  status: ToolStatus
  output?: string
  /** 放到后台跑的（子代理、后台 Bash）：tool_result 只说明已启动，跑完看 task_notification */
  background?: boolean
  /** 后台任务结束时的一句话摘要 */
  summary?: string
}

export type Item =
  | { kind: 'user'; key: string; text: string }
  | { kind: 'text'; key: string; text: string }
  | { kind: 'thinking'; key: string; text: string }
  | ToolItem
  | { kind: 'result'; key: string; ok: boolean; text: string }
  | { kind: 'note'; key: string; text: string; tone: 'muted' | 'error' }

export type TodoStatus = 'pending' | 'in_progress' | 'completed'

/** 进度条的一项：TodoWrite 的一条，或 TaskCreate 建的一个任务（id 在 tool_result 里才有） */
export interface Todo {
  key: string
  id?: string
  content: string
  activeForm?: string
  status: TodoStatus
}

export interface View {
  epoch: string
  lastSeq: number
  /** 主链的条目 */
  items: Item[]
  /** 子代理内部的条目，按调用它的那次 Agent 工具的 id 收纳 */
  sub: Record<string, Item[]>
  /** Todo / Task 工具的进度，不进消息流 */
  todos: Todo[]
  /** 按到达顺序，底部弹层处理第一个 */
  pending: PermissionRequest[]
  interrupted: boolean
  /** 正在压缩对话 */
  compacting: boolean
}

export const emptyView = (epoch = ''): View => ({
  epoch,
  lastSeq: 0,
  items: [],
  sub: {},
  todos: [],
  pending: [],
  interrupted: false,
  compacting: false,
})

/** 只更新进度条、不进消息流的工具 */
export const TODO_TOOLS = new Set(['TodoWrite', 'TaskCreate', 'TaskUpdate', 'TaskGet', 'TaskList'])
const TODO_STATUS = new Set<unknown>(['pending', 'in_progress', 'completed'])

const RESULT_ERROR: Record<string, string> = {
  error_during_execution: '执行出错',
  error_max_turns: '达到最大轮数',
  error_max_budget_usd: '超出预算上限',
  error_max_structured_output_retries: '结构化输出重试次数用完',
}

type Block = { type: string; [k: string]: unknown }

function contentBlocks(content: unknown): Block[] {
  if (typeof content === 'string') return [{ type: 'text', text: content }]
  return Array.isArray(content) ? (content as Block[]) : []
}

function toolResultText(content: unknown): string {
  return contentBlocks(content)
    .map((b) => (b.type === 'text' ? String(b.text) : `[${b.type}]`))
    .join('\n')
}

/**
 * 子代理交回的结果：CLI 在报告前加一行来源声明（顶格），报告每行缩进两格（附注也缩进，放在声明之前）。
 * 卡片上只留报告；没有声明的原样返回
 */
function agentReport(text: string): string {
  const frame = /^\[Subagent hand-back\] .*\n?/m.exec(text)
  if (!frame) return text
  const lines = text.slice(frame.index + frame[0].length).split('\n')
  const end = lines.findIndex((l) => !l.startsWith('  '))
  return (end < 0 ? lines : lines.slice(0, end)).map((l) => l.slice(2)).join('\n')
}

const str = (v: unknown) => (typeof v === 'string' ? v : undefined)

const tokens = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n))

export function applyEvents(v: View, envs: EventEnvelope[]): View {
  const fresh = envs.filter((e) => e.seq > v.lastSeq)
  if (fresh.length === 0) return v

  // 条目只换不改：store 按 key 合并时，拿新旧对象比对才知道哪里变了
  const items = v.items.slice()
  const sub = { ...v.sub }
  const copied = new Set<string>()
  /** 主链的，或某个子代理的条目列表（子代理的第一次改时复制一份） */
  const list = (parent: string | null): Item[] => {
    if (!parent) return items
    if (!copied.has(parent)) {
      copied.add(parent)
      sub[parent] = [...(sub[parent] ?? [])]
    }
    return sub[parent]!
  }
  /** 找到工具条目换成 fn 的结果。parent 为 undefined 时主链、各子代理都找 */
  const updateTool = (id: string, parent: string | null | undefined, fn: (t: ToolItem) => ToolItem) => {
    const where = parent !== undefined ? [parent] : [null, ...Object.keys(sub)]
    for (const p of where) {
      const idx = (p ? (sub[p] ?? []) : items).findLastIndex((it) => it.kind === 'tool' && it.id === id)
      if (idx < 0) continue
      const l = list(p)
      l[idx] = fn(l[idx] as ToolItem)
      return
    }
  }
  let { todos, pending, interrupted, compacting } = v

  const onTodoTool = (id: string, name: string, input: Record<string, unknown>) => {
    if (name === 'TodoWrite' && Array.isArray(input.todos)) {
      // 每次全量替换
      todos = (input.todos as Record<string, unknown>[]).map((t, i) => ({
        key: `${id}:${i}`,
        content: str(t.content) ?? '',
        activeForm: str(t.activeForm),
        status: TODO_STATUS.has(t.status) ? (t.status as TodoStatus) : 'pending',
      }))
    } else if (name === 'TaskCreate') {
      todos = [...todos, { key: id, content: str(input.subject) ?? '', activeForm: str(input.activeForm ?? input.active_form), status: 'pending' }]
    } else if (name === 'TaskUpdate') {
      // 模型的原始输出，字段名不一定规整
      const tid = String(input.taskId ?? input.id ?? input.task_id ?? '')
      const idx = todos.findIndex((t) => t.id === tid)
      if (idx < 0) return
      if (input.status === 'deleted') return void (todos = todos.filter((_, i) => i !== idx))
      const t = todos[idx]!
      todos = todos.with(idx, {
        ...t,
        content: str(input.subject) ?? t.content,
        activeForm: str(input.activeForm ?? input.active_form) ?? t.activeForm,
        status: TODO_STATUS.has(input.status) ? (input.status as TodoStatus) : t.status,
      })
    }
  }

  // TaskCreate 分配的 id 在结果里：「Task #3 created successfully: …」（CLI 自己也这样解析）
  const onTodoResult = (toolUseId: string, text: string, isError: boolean) => {
    const idx = todos.findIndex((t) => t.key === toolUseId && t.id === undefined)
    if (idx < 0) return
    const id = text.match(/Task #(\S+) created successfully/)?.[1]
    if (id) todos = todos.with(idx, { ...todos[idx]!, id })
    else if (isError) todos = todos.filter((_, i) => i !== idx)
  }

  const onSdk = (msg: SDKMessage, key: string) => {
    switch (msg.type) {
      case 'assistant': {
        const parent = msg.parent_tool_use_id
        const l = list(parent)
        contentBlocks(msg.message.content).forEach((b, i) => {
          const k = `${key}:${i}`
          if (b.type === 'text' && String(b.text).trim()) l.push({ kind: 'text', key: k, text: String(b.text) })
          else if (b.type === 'thinking' && String(b.thinking).trim()) l.push({ kind: 'thinking', key: k, text: String(b.thinking) })
          else if (b.type === 'tool_use') {
            const id = String(b.id)
            const name = String(b.name)
            const input = (b.input ?? {}) as Record<string, unknown>
            if (TODO_TOOLS.has(name)) return parent ? undefined : onTodoTool(id, name, input)
            l.push({ kind: 'tool', key: k, id, name, input, status: 'running' })
          }
        })
        if (msg.error) l.push({ kind: 'note', key: `${key}:err`, text: `出错：${msg.error}`, tone: 'error' })
        return
      }
      case 'user': {
        if ('isReplay' in msg && msg.isReplay) return
        const parent = msg.parent_tool_use_id
        contentBlocks(msg.message.content).forEach((b, i) => {
          if (b.type === 'tool_result') {
            const id = String(b.tool_use_id)
            const output = toolResultText(b.content)
            if (!parent) onTodoResult(id, output, !!b.is_error)
            // 放到后台的，结果只是「已启动」，状态等 task_notification
            updateTool(id, parent, (t) => ({
              ...t,
              output: t.name === 'Agent' || t.name === 'Task' ? agentReport(output) : output,
              status: b.is_error ? 'error' : t.background ? t.status : 'ok',
            }))
          } else if (b.type === 'text' && !parent) {
            // 子代理的 user 文本是交给它的 prompt，卡片上已经有了
            const text = String(b.text)
            if (text.startsWith('[Request interrupted')) interrupted = true
            items.push({ kind: 'note', key: `${key}:${i}`, text, tone: 'muted' })
          }
        })
        return
      }
      case 'result': {
        compacting = false
        let text: string
        let ok = true
        if (msg.subtype === 'success' && !msg.is_error) {
          text = `完成 · ${duration(msg.duration_ms)} · 累计 $${msg.total_cost_usd.toFixed(2)}`
        } else if (interrupted) {
          text = '已中断'
        } else {
          ok = false
          // errors 里 [ede_diagnostic] 这类是内部诊断，不给人看
          const detail = msg.subtype === 'success' ? msg.result : msg.errors?.find((e) => !e.startsWith('['))
          text = `${RESULT_ERROR[msg.subtype] ?? '出错'}${detail ? `：${detail.slice(0, 300)}` : ''}`
        }
        items.push({ kind: 'result', key, ok, text })
        return
      }
      case 'system': {
        // init / status 里的模型、权限模式由服务端记在 SessionInfo 里
        const note = (text: string, tone: 'muted' | 'error' = 'muted') => items.push({ kind: 'note', key, text, tone })
        switch (msg.subtype) {
          case 'status':
            compacting = msg.status === 'compacting'
            if (msg.compact_result === 'failed') note(`压缩失败${msg.compact_error ? `：${msg.compact_error}` : ''}`, 'error')
            return
          case 'compact_boundary': {
            const m = msg.compact_metadata
            return note(`对话已压缩（${m.trigger === 'auto' ? '自动' : '手动'} · 压缩前 ${tokens(m.pre_tokens)} tokens）`)
          }
          case 'local_command_output':
            return note(msg.content)
          case 'api_retry':
            return note(`API 重试 ${msg.attempt}/${msg.max_retries}${msg.error_status ? `（${msg.error_status}）` : ''}`)
          case 'informational':
            return note(msg.content, msg.level === 'warning' ? 'error' : 'muted')
          case 'notification':
            // 终端里弹一下就消失的提示，只留要紧的
            if (msg.priority === 'high' || msg.priority === 'immediate') note(msg.text)
            return
          case 'task_started':
            if (msg.is_backgrounded && msg.tool_use_id)
              updateTool(msg.tool_use_id, undefined, (t) => ({ ...t, background: true, status: t.status === 'error' ? 'error' : 'running' }))
            return
          case 'task_notification':
            if (msg.tool_use_id)
              updateTool(msg.tool_use_id, undefined, (t) =>
                t.background ? { ...t, status: msg.status === 'completed' ? 'ok' : 'error', summary: msg.summary } : t,
              )
            return
        }
      }
    }
  }

  for (const { seq, ev } of fresh) {
    // 带上 epoch：服务端重启后 seq 从头数，key 不能和旧条目撞上（合并 store 时按 key 认条目）
    const key = `${v.epoch}.${seq}`
    switch (ev.type) {
      case 'user_input':
        interrupted = false
        items.push({ kind: 'user', key, text: ev.text })
        break
      case 'sdk':
        onSdk(ev.msg, key)
        break
      case 'permission_request': {
        const { req } = ev
        pending = [...pending, req]
        // CLI 补全过的 input（ExitPlanMode 的计划正文只在这里有），并进对应的工具条目
        if (req.toolUseId) updateTool(req.toolUseId, undefined, (t) => ({ ...t, input: { ...t.input, ...req.input } }))
        break
      }
      case 'permission_resolved':
        pending = pending.filter((r) => r.id !== ev.id)
        break
      case 'error':
        items.push({ kind: 'note', key, text: ev.message, tone: 'error' })
        break
      case 'note':
        items.push({ kind: 'note', key, text: ev.text, tone: 'muted' })
        break
    }
  }

  return { epoch: v.epoch, lastSeq: fresh.at(-1)!.seq, items, sub, todos, pending, interrupted, compacting }
}
