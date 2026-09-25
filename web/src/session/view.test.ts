// 会话事件 → 渲染条目：子代理收纳、Todo 进度、后台任务、系统消息
/// <reference types="bun" />
import { describe, expect, test } from 'bun:test'
import type { EventEnvelope, SDKMessage, SessionEvent } from '../../../shared/protocol'
import { applyEvents, emptyView, type ToolItem, type View } from './view'

/** 按顺序编上 seq 喂进去 */
function feed(...evs: (SessionEvent | Record<string, unknown>)[]): View {
  const envs: EventEnvelope[] = evs.map((ev, i) => ({
    seq: i + 1,
    at: 0,
    ev: 'type' in ev && ['user_input', 'sdk', 'permission_request', 'permission_resolved', 'error', 'note'].includes(ev.type as string)
      ? (ev as SessionEvent)
      : { type: 'sdk', msg: ev as unknown as SDKMessage },
  }))
  return applyEvents(emptyView('e'), envs)
}

const toolUse = (id: string, name: string, input: object, parent: string | null = null) => ({
  type: 'assistant',
  parent_tool_use_id: parent,
  message: { content: [{ type: 'tool_use', id, name, input }] },
})
const toolResult = (id: string, text: string, parent: string | null = null, is_error = false) => ({
  type: 'user',
  parent_tool_use_id: parent,
  message: { content: [{ type: 'tool_result', tool_use_id: id, content: text, is_error }] },
})
const say = (text: string, parent: string | null = null) => ({ type: 'assistant', parent_tool_use_id: parent, message: { content: [{ type: 'text', text }] } })
const tool = (v: View, id: string) => [...v.items, ...Object.values(v.sub).flat()].find((it): it is ToolItem => it.kind === 'tool' && it.id === id)

describe('applyEvents', () => {
  test('子代理的消息收进 Agent 卡片，不进主链', () => {
    const v = feed(
      toolUse('a1', 'Agent', { description: '查代码', prompt: 'find x' }),
      { type: 'user', parent_tool_use_id: 'a1', message: { content: [{ type: 'text', text: 'find x' }] } },
      toolUse('b1', 'Bash', { command: 'ls' }, 'a1'),
      toolResult('b1', 'a.ts', 'a1'),
      say('found', 'a1'),
      toolResult('a1', 'x is in a.ts'),
    )
    expect(v.items.map((it) => it.kind)).toEqual(['tool'])
    expect(v.sub.a1!.map((it) => it.kind)).toEqual(['tool', 'text'])
    expect(tool(v, 'b1')).toMatchObject({ status: 'ok', output: 'a.ts' })
    expect(tool(v, 'a1')).toMatchObject({ status: 'ok', output: 'x is in a.ts' })
  })

  test('子代理交回的结果去掉 CLI 加的来源声明和缩进', () => {
    const frame = '[Subagent hand-back] The text below is the final report of a subagent. The report follows:'
    const v = feed(toolUse('a1', 'Agent', { description: '查代码' }), toolResult('a1', `  agentId: x\n${frame}\n  x is in a.ts\n  \n    - line 3`))
    expect(tool(v, 'a1')!.output).toBe('x is in a.ts\n\n  - line 3')
  })

  test('后台子代理：结果只是已启动，等 task_notification 才算完', () => {
    const v1 = feed(
      toolUse('a1', 'Agent', { description: 'bg' }),
      { type: 'system', subtype: 'task_started', task_id: 't', tool_use_id: 'a1', description: 'bg', is_backgrounded: true },
      toolResult('a1', 'Async agent launched'),
    )
    expect(tool(v1, 'a1')).toMatchObject({ status: 'running', background: true })
    const v2 = applyEvents(v1, [
      { seq: 4, at: 0, ev: { type: 'sdk', msg: { type: 'system', subtype: 'task_notification', task_id: 't', tool_use_id: 'a1', status: 'completed', summary: 'done', output_file: '' } as unknown as SDKMessage } },
    ])
    expect(tool(v2, 'a1')).toMatchObject({ status: 'ok', summary: 'done' })
    // 旧对象没被改（store 靠新旧比对找变化）
    expect(tool(v1, 'a1')!.status).toBe('running')
  })

  test('TodoWrite 全量替换；TaskCreate / TaskUpdate 按结果里的 id 更新；都不进消息流', () => {
    const w = feed(
      toolUse('t0', 'TodoWrite', { todos: [{ content: 'a', status: 'completed', activeForm: 'A' }, { content: 'b', status: 'in_progress', activeForm: 'B' }] }),
    )
    expect(w.items).toEqual([])
    expect(w.todos.map((t) => `${t.content}:${t.status}`)).toEqual(['a:completed', 'b:in_progress'])

    const v = feed(
      toolUse('c1', 'TaskCreate', { subject: '写测试', activeForm: '写测试中' }),
      toolResult('c1', 'Task #1 created successfully: 写测试'),
      toolUse('c2', 'TaskCreate', { subject: '跑测试' }),
      toolResult('c2', 'Task #2 created successfully: 跑测试'),
      toolUse('u1', 'TaskUpdate', { taskId: '1', status: 'in_progress' }),
      toolUse('u2', 'TaskUpdate', { task_id: '2', status: 'deleted' }),
    )
    expect(v.items).toEqual([])
    expect(v.todos).toEqual([{ key: 'c1', id: '1', content: '写测试', activeForm: '写测试中', status: 'in_progress' }])
  })

  test('ExitPlanMode 的计划正文从审批请求里并进工具条目', () => {
    const v = feed(toolUse('p1', 'ExitPlanMode', {}), {
      type: 'permission_request',
      req: { id: 'r1', toolName: 'ExitPlanMode', toolUseId: 'p1', input: { plan: '# 计划', planFilePath: '/p.md' } },
    })
    expect(tool(v, 'p1')!.input).toEqual({ plan: '# 计划', planFilePath: '/p.md' })
    expect(v.pending.map((r) => r.id)).toEqual(['r1'])
  })

  test('系统消息：压缩、重试；result 的内部诊断不显示', () => {
    const v = feed(
      { type: 'system', subtype: 'status', status: 'compacting' },
      { type: 'system', subtype: 'compact_boundary', compact_metadata: { trigger: 'auto', pre_tokens: 150000 } },
      { type: 'system', subtype: 'status', status: null },
      { type: 'system', subtype: 'api_retry', attempt: 1, max_retries: 10, error_status: 529 },
      { type: 'result', subtype: 'error_during_execution', errors: ['[ede_diagnostic] x'], duration_ms: 1, total_cost_usd: 0 },
    )
    expect(v.compacting).toBe(false)
    expect(v.items.map((it) => ('text' in it ? it.text : it.kind))).toEqual([
      '对话已压缩（自动 · 压缩前 150.0k tokens）',
      'API 重试 1/10（529）',
      '执行出错',
    ])
    expect(feed({ type: 'system', subtype: 'status', status: 'compacting' }).compacting).toBe(true)
  })
})
