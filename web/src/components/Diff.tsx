import { diffLines } from 'diff'
import { For, Show } from 'solid-js'

/** 一处改动：改之前、改之后的文本 */
export interface Hunk {
  before: string
  after: string
}

type Line = { sign: '+' | '-' | ' '; text: string }

/**
 * Edit / MultiEdit / Write 的改动。只看 input 算（与 transcript 载入的一致），所以没有行号；
 * Write 覆盖已有文件时也不知道原来的内容，整段算新增
 */
export function editHunks(name: string, input: Record<string, unknown>): Hunk[] | undefined {
  const s = (v: unknown) => (typeof v === 'string' ? v : '')
  if (name === 'Edit') return [{ before: s(input.old_string), after: s(input.new_string) }]
  if (name === 'Write') return [{ before: '', after: s(input.content) }]
  if (name === 'MultiEdit' && Array.isArray(input.edits))
    return (input.edits as Record<string, unknown>[]).map((e) => ({ before: s(e.old_string), after: s(e.new_string) }))
}

function hunkLines(h: Hunk): Line[] {
  const out: Line[] = []
  for (const part of diffLines(h.before, h.after)) {
    const sign = part.added ? '+' : part.removed ? '-' : ' '
    const lines = part.value.split('\n')
    if (lines.at(-1) === '') lines.pop()
    for (const text of lines) out.push({ sign, text })
  }
  return out
}

/** +N −M */
export function diffStat(hunks: Hunk[]): { added: number; removed: number } {
  let added = 0
  let removed = 0
  for (const h of hunks)
    for (const part of diffLines(h.before, h.after)) {
      if (part.added) added += part.count
      else if (part.removed) removed += part.count
    }
  return { added, removed }
}

export function DiffStat(props: { hunks: Hunk[] }) {
  const stat = () => diffStat(props.hunks)
  return (
    <span class="shrink-0 font-mono">
      <Show when={stat().added}>
        <span class="text-emerald-500">+{stat().added}</span>
      </Show>
      <Show when={stat().removed}>
        <span class="ml-1 text-red-400">−{stat().removed}</span>
      </Show>
    </span>
  )
}

const LINE_CLASS = { '+': 'bg-emerald-950/60 text-emerald-200', '-': 'bg-red-950/60 text-red-200', ' ': 'text-neutral-400' }

/** 上下排的行级 diff，多处改动之间用 ⋯ 隔开 */
export function DiffView(props: { hunks: Hunk[]; class?: string }) {
  return (
    <div class={`overflow-auto rounded-lg border border-neutral-800 bg-neutral-950 py-1 font-mono text-[11px] leading-relaxed ${props.class ?? ''}`}>
      <For each={props.hunks}>
        {(h, i) => (
          <>
            <Show when={i() > 0}>
              <div class="px-2 text-neutral-600">⋯</div>
            </Show>
            <For each={hunkLines(h)}>
              {(l) => (
                <div class={`flex px-2 whitespace-pre-wrap ${LINE_CLASS[l.sign]}`}>
                  <span class="w-3 shrink-0 select-none opacity-60">{l.sign}</span>
                  <span class="min-w-0 break-all">{l.text || ' '}</span>
                </div>
              )}
            </For>
          </>
        )}
      </For>
    </div>
  )
}
