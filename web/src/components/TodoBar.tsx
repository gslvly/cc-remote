import { createSignal, For, Show } from 'solid-js'
import type { Todo, TodoStatus } from '../session/view'

const ICON: Record<TodoStatus, [string, string]> = {
  completed: ['✓', 'text-neutral-600 line-through'],
  in_progress: ['▸', 'text-neutral-100'],
  pending: ['○', 'text-neutral-400'],
}

/**
 * Todo / Task 工具的进度条（Claude Code 用了这些工具才有，不去开启它）。
 * 收起时是进度和正在做的那项，点开看全部；都做完了就不显示
 */
export function TodoBar(props: { todos: Todo[] }) {
  const [open, setOpen] = createSignal(false)
  const done = () => props.todos.filter((t) => t.status === 'completed').length
  const current = () => props.todos.find((t) => t.status === 'in_progress')
  return (
    <Show when={props.todos.length && done() < props.todos.length}>
      <div class="border-b border-neutral-800 px-4 py-1.5 text-xs">
        <button onClick={() => setOpen(!open())} class="flex w-full items-center gap-2 text-left">
          <span class="shrink-0 text-neutral-400 tabular-nums">
            {done()}/{props.todos.length}
          </span>
          <span class="h-1 w-14 shrink-0 overflow-hidden rounded bg-neutral-800">
            <span class="block h-full bg-emerald-500" style={{ width: `${(done() / props.todos.length) * 100}%` }} />
          </span>
          <span class="min-w-0 flex-1 truncate text-neutral-300">{current()?.activeForm || current()?.content || ''}</span>
          <span class="shrink-0 text-neutral-500">{open() ? '▴' : '▾'}</span>
        </button>
        <Show when={open()}>
          <ul class="mt-1.5 space-y-0.5 pb-1">
            <For each={props.todos}>
              {(t) => (
                <li class={`flex gap-2 ${ICON[t.status][1]}`}>
                  <span class="w-3 shrink-0 text-center">{ICON[t.status][0]}</span>
                  <span class="min-w-0">{t.content}</span>
                </li>
              )}
            </For>
          </ul>
        </Show>
      </div>
    </Show>
  )
}
