import { createMemo, createSignal, For, Match, type ParentProps, Show, Switch } from 'solid-js'
import type { LiveBlock } from '../../../shared/protocol'
import { shortPath } from '../format'
import type { Item, ToolItem, ToolStatus } from '../session/view'
import { DiffStat, DiffView, editHunks } from './Diff'
import { Markdown } from './Markdown'
import { questionsOf } from './QuestionSheet'

const str = (v: unknown) => (typeof v === 'string' ? v : '')

/** mcp__server__tool → [server, tool] */
const mcpName = (name: string) => {
  const rest = name.slice('mcp__'.length)
  const i = rest.indexOf('__')
  return i < 0 ? [rest, ''] : [rest.slice(0, i), rest.slice(i + 2)]
}

// 不认识的工具：取 input 里最能说明这次调用的字段
const SUMMARY_KEYS = ['command', 'file_path', 'notebook_path', 'pattern', 'url', 'query', 'description', 'prompt', 'skill']

function genericSummary(name: string, input: Record<string, unknown>): string {
  for (const k of SUMMARY_KEYS) {
    const v = input[k]
    if (typeof v !== 'string' || !v) continue
    return `${name} ${k.endsWith('path') ? shortPath(v) : v}`
  }
  const first = Object.values(input).find((v) => typeof v === 'string')
  return first ? `${name} ${first}` : name
}

/** 工具的一行摘要。参数还在生成时（只有部分字段）也用它 */
export function toolSummary(name: string, input: Record<string, unknown>): string {
  const path = (k = 'file_path') => shortPath(str(input[k]))
  const where = input.path ? ` · ${shortPath(str(input.path))}` : ''
  switch (name) {
    case 'Bash':
      return `$ ${str(input.command)}`
    case 'Read': {
      const from = Number(input.offset) || 0
      const n = Number(input.limit) || 0
      const range = n ? ` · ${from || 1}–${(from || 1) + n - 1} 行` : from ? ` · 从第 ${from} 行` : ''
      return `Read ${path()}${range}${input.pages ? ` · 第 ${str(input.pages)} 页` : ''}`
    }
    case 'Write':
      return `Write ${path()}`
    case 'Edit':
    case 'MultiEdit':
      return `Edit ${path()}`
    case 'NotebookEdit':
      return `NotebookEdit ${path('notebook_path')}`
    case 'Grep':
      return `Grep ${str(input.pattern)}${where}${input.glob ? ` · ${str(input.glob)}` : ''}`
    case 'Glob':
      return `Glob ${str(input.pattern)}${where}`
    case 'WebFetch':
      return `Fetch ${str(input.url).replace(/^https?:\/\//, '')}`
    case 'WebSearch':
      return `Search ${str(input.query)}`
    case 'Agent':
    case 'Task':
      return `${str(input.subagent_type) || 'Agent'} · ${str(input.description)}`
    case 'Skill':
      return `Skill ${str(input.skill)}${input.args ? ` ${str(input.args)}` : ''}`
    case 'AskUserQuestion':
      return `提问 · ${questionsOf(input)
        .map((q) => q.header || q.question)
        .join('、')}`
    case 'ExitPlanMode':
      return '计划'
  }
  if (name.startsWith('mcp__')) {
    const [server, tool] = mcpName(name)
    const first = Object.values(input).find((v) => typeof v === 'string')
    return `${server} · ${tool}${first ? ` ${first}` : ''}`
  }
  return genericSummary(name, input)
}

/** 还在生成的工具参数是不完整的 JSON：取出其中已经写完的字符串字段，给 toolSummary 用 */
export function partialInput(json: string): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [, k, v] of json.matchAll(/"(\w+)"\s*:\s*"((?:[^"\\]|\\.)*)"/g)) {
    try {
      out[k!] ??= JSON.parse(`"${v}"`)
    } catch {}
  }
  return out
}

const STATUS: Record<ToolStatus, [string, string]> = {
  running: ['•', 'text-sky-400 animate-pulse'],
  ok: ['✓', 'text-emerald-500'],
  error: ['✗', 'text-red-400'],
}

function StatusIcon(props: { status: ToolStatus }) {
  return <span class={`w-3 shrink-0 text-center ${STATUS[props.status][1]}`}>{STATUS[props.status][0]}</span>
}

function Pre(props: ParentProps<{ error?: boolean }>) {
  return (
    <pre
      class={`max-h-80 overflow-auto rounded-lg border border-neutral-800 bg-neutral-950 p-2.5 font-mono text-[11px] leading-relaxed whitespace-pre-wrap break-all ${
        props.error ? 'text-red-300' : 'text-neutral-300'
      }`}
    >
      {props.children}
    </pre>
  )
}

/** 工具的输出；放到后台跑完的还有一句摘要 */
function Output(props: { item: ToolItem }) {
  return (
    <>
      <Show when={props.item.output !== undefined}>
        <Pre error={props.item.status === 'error'}>{props.item.output || '（无输出）'}</Pre>
      </Show>
      <Show when={props.item.summary}>
        <p class="text-xs text-neutral-500">后台任务结束：{props.item.summary}</p>
      </Show>
    </>
  )
}

/** 点开之后：Bash 是完整命令加输出，改文件的是 diff，查找类只看结果，其余是参数加结果 */
function ToolDetail(props: { item: ToolItem }) {
  const name = props.item.name
  const input = () => props.item.input
  const hunks = createMemo(() => editHunks(name, input()))
  return (
    <div class="mt-1 mb-2 space-y-2">
      <Switch
        fallback={
          <>
            <Pre>{JSON.stringify(input(), null, 2)}</Pre>
            <Output item={props.item} />
          </>
        }
      >
        <Match when={name === 'Bash'}>
          <Show when={str(input().description)}>
            <p class="text-xs text-neutral-500">{str(input().description)}</p>
          </Show>
          <Pre>$ {str(input().command)}</Pre>
          <Output item={props.item} />
        </Match>
        <Match when={hunks()}>
          {(h) => (
            <>
              <DiffView hunks={h()} class="max-h-96" />
              {/* 改成功了结果只是一句「已更新」，失败了才看 */}
              <Show when={props.item.status === 'error'}>
                <Output item={props.item} />
              </Show>
            </>
          )}
        </Match>
        <Match when={['Read', 'Grep', 'Glob', 'WebFetch', 'WebSearch', 'Skill'].includes(name)}>
          <Output item={props.item} />
        </Match>
        <Match when={name === 'AskUserQuestion'}>
          <For each={questionsOf(input())}>
            {(q) => (
              <p class="text-xs text-neutral-400">
                <span class="text-neutral-500">{q.header} · </span>
                {q.question}
                <span class="text-neutral-600"> （{q.options.map((o) => o.label).join(' / ')}）</span>
              </p>
            )}
          </For>
          <Output item={props.item} />
        </Match>
      </Switch>
    </div>
  )
}

function ToolRow(props: { item: ToolItem }) {
  const [open, setOpen] = createSignal(false)
  const hunks = createMemo(() => editHunks(props.item.name, props.item.input))
  return (
    <div>
      <button
        onClick={() => setOpen(!open())}
        class="flex w-full items-center gap-2 rounded-md py-1 text-left font-mono text-xs text-neutral-400"
      >
        <StatusIcon status={props.item.status} />
        <span class="min-w-0 flex-1 truncate">{toolSummary(props.item.name, props.item.input)}</span>
        <Show when={hunks()}>{(h) => <DiffStat hunks={h()} />}</Show>
        <Show when={props.item.background && props.item.status === 'running'}>
          <span class="shrink-0 text-neutral-600">后台</span>
        </Show>
      </button>
      <Show when={open()}>
        <ToolDetail item={props.item} />
      </Show>
    </div>
  )
}

/** 子代理：折叠卡片，里面是它自己的工具调用和话（按 parent_tool_use_id 收纳），最后是交回来的结果 */
function AgentCard(props: { item: ToolItem; sub: Record<string, Item[]> }) {
  const [open, setOpen] = createSignal(false)
  const children = () => props.sub[props.item.id] ?? []
  const tools = () => children().filter((c): c is ToolItem => c.kind === 'tool')
  // 收着的时候，跑到哪了看最后一个工具调用
  const current = () => {
    const last = tools().at(-1)
    return props.item.status === 'running' && last ? toolSummary(last.name, last.input) : ''
  }
  return (
    <div class="rounded-xl border border-neutral-800">
      <button onClick={() => setOpen(!open())} class="flex w-full flex-col gap-0.5 px-3 py-2 text-left text-xs">
        <span class="flex w-full items-center gap-2">
          <StatusIcon status={props.item.status} />
          <span class="min-w-0 flex-1 truncate text-neutral-300">{toolSummary(props.item.name, props.item.input)}</span>
          <span class="shrink-0 text-neutral-500">
            {props.item.background ? '后台 · ' : ''}
            {tools().length} 次调用
          </span>
        </span>
        <Show when={current()}>
          <span class="truncate pl-5 font-mono text-neutral-500">↳ {current()}</span>
        </Show>
      </button>
      <Show when={open()}>
        <div class="space-y-2 border-t border-neutral-800 px-3 py-2">
          <details class="text-xs text-neutral-500">
            <summary class="cursor-pointer select-none">交给它的任务</summary>
            <p class="mt-1 whitespace-pre-wrap">{str(props.item.input.prompt)}</p>
          </details>
          <For each={children()}>{(c) => <ItemView item={c} sub={props.sub} />}</For>
          <Show when={props.item.summary}>
            <p class="text-xs text-neutral-500">后台任务结束：{props.item.summary}</p>
          </Show>
          <Show when={props.item.output}>
            {(out) => (
              <Show when={props.item.status !== 'error'} fallback={<Pre error>{out()}</Pre>}>
                <Markdown text={out()} class="text-sm" />
              </Show>
            )}
          </Show>
        </div>
      </Show>
    </div>
  )
}

const PLAN_STATUS: Record<ToolStatus, string> = { running: '等待批准', ok: '已批准', error: '未批准' }

/** ExitPlanMode：计划正文来自审批请求（CLI 补进 input 的）；从 transcript 载入的没有，就看结果里的 */
function PlanCard(props: { item: ToolItem }) {
  const [open, setOpen] = createSignal(false)
  const text = () => str(props.item.input.plan) || props.item.output || ''
  return (
    <div class="rounded-xl border border-neutral-800">
      <button onClick={() => setOpen(!open())} class="flex w-full items-center gap-2 px-3 py-2 text-left text-xs">
        <StatusIcon status={props.item.status} />
        <span class="flex-1 text-neutral-300">计划</span>
        <span class="text-neutral-500">{PLAN_STATUS[props.item.status]}</span>
      </button>
      <Show when={open() && text()}>
        <Markdown text={text()} class="border-t border-neutral-800 px-3 py-2 text-sm" />
      </Show>
    </div>
  )
}

// 同一个 key 的条目 kind 不会变（store 按 key 合并），所以按 kind 分支只在创建时判断一次；
// 分支里读 item 的字段仍是响应式的，文本、工具状态变了会原地更新
export function ItemView(props: { item: Item; sub: Record<string, Item[]> }) {
  const item = props.item
  switch (item.kind) {
    case 'user':
      return (
        <div class="flex justify-end">
          <div class="max-w-[85%] rounded-2xl rounded-br-md bg-neutral-800 px-3.5 py-2 whitespace-pre-wrap">{item.text}</div>
        </div>
      )
    case 'text':
      return <Markdown text={item.text} />
    case 'thinking':
      return (
        <details class="text-xs text-neutral-500">
          <summary class="cursor-pointer select-none">思考</summary>
          <p class="mt-1 whitespace-pre-wrap">{item.text}</p>
        </details>
      )
    case 'tool':
      if (item.name === 'Agent' || item.name === 'Task') return <AgentCard item={item} sub={props.sub} />
      if (item.name === 'ExitPlanMode') return <PlanCard item={item} />
      return <ToolRow item={item} />
    case 'result':
      return <p class={`py-1 text-center text-xs ${item.ok ? 'text-neutral-500' : 'text-red-400'}`}>{item.text}</p>
    case 'note':
      return (
        <p class={`text-xs whitespace-pre-wrap ${item.tone === 'error' ? 'text-red-400' : 'text-neutral-500'}`}>
          {item.text}
        </p>
      )
  }
}

/**
 * 正在生成的那一块：文本逐字蹦出；思考没有正文，只显示估算的 token 数；
 * 工具参数按字段整段到达（Write 的 content 要等整段写完），先用已经到了的字段（文件名、命令）显示摘要
 */
export function LiveView(props: { block: LiveBlock }) {
  return (
    <Switch>
      <Match when={props.block.kind === 'text' && props.block}>
        {(b) => <Markdown text={b().text} class="live" />}
      </Match>
      <Match when={props.block.kind === 'thinking' && props.block}>
        {(b) => (
          <p class="text-xs text-neutral-500">
            <span class="animate-pulse">思考中…</span>
            {b().tokens ? ` 约 ${b().tokens} tokens` : ''}
          </p>
        )}
      </Match>
      <Match when={props.block.kind === 'tool' && props.block}>
        {(b) => (
          <div class="flex items-center gap-2 py-1 font-mono text-xs text-neutral-400">
            <StatusIcon status="running" />
            <span class="truncate">{toolSummary(b().name, partialInput(b().head))}</span>
            <span class="shrink-0 text-neutral-600">生成中…</span>
          </div>
        )}
      </Match>
    </Switch>
  )
}
