import { createSignal, For, Index, Show } from 'solid-js'
import { type SheetProps, Sheet, SheetHead, primary, secondary, useDecide } from './PermissionSheet'

export interface Question {
  question: string
  header: string
  options: { label: string; description?: string; preview?: string }[]
  multiSelect: boolean
}

/** AskUserQuestion 的 input.questions（模型的原始输出，先过一遍） */
export function questionsOf(input: Record<string, unknown>): Question[] {
  if (!Array.isArray(input.questions)) return []
  return (input.questions as Partial<Question>[])
    .filter((q) => typeof q?.question === 'string')
    .map((q) => ({
      question: q.question!,
      header: q.header ?? '',
      options: Array.isArray(q.options) ? q.options.filter((o) => typeof o?.label === 'string') : [],
      multiSelect: !!q.multiSelect,
    }))
}

/**
 * AskUserQuestion：每个问题点选项（多选可以点几个），也可以自己写。
 * 回答按问题原文索引，多选的 label 用逗号拼接（sdk-tools.d.ts 的说明）；选中的选项带 preview 的，一并放进 annotations
 */
export function QuestionSheet(props: SheetProps) {
  const { busy, error, decide } = useDecide(props)
  const questions = questionsOf(props.req.input)
  const [picked, setPicked] = createSignal<string[][]>(questions.map(() => []))
  const [other, setOther] = createSignal<string[]>(questions.map(() => ''))

  const pick = (qi: number, label: string) => {
    const q = questions[qi]!
    const cur = picked()[qi]!
    const next = q.multiSelect ? (cur.includes(label) ? cur.filter((l) => l !== label) : [...cur, label]) : [label]
    setPicked(picked().with(qi, next))
    // 单选：点了选项就不用自己写的
    if (!q.multiSelect) setOther(other().with(qi, ''))
  }
  const write = (qi: number, text: string) => {
    setOther(other().with(qi, text))
    if (!questions[qi]!.multiSelect && text.trim()) setPicked(picked().with(qi, []))
  }
  const answer = (qi: number) => [...picked()[qi]!, other()[qi]!.trim()].filter(Boolean).join(', ')
  const preview = (qi: number) => {
    const q = questions[qi]!
    return q.multiSelect ? undefined : q.options.find((o) => o.label === picked()[qi]![0])?.preview
  }
  const ready = () => questions.length > 0 && questions.every((_, i) => answer(i))

  const submit = () => {
    const annotations: Record<string, { preview: string }> = {}
    questions.forEach((q, i) => {
      const p = preview(i)
      if (p) annotations[q.question] = { preview: p }
    })
    return decide({
      behavior: 'allow',
      answers: Object.fromEntries(questions.map((q, i) => [q.question, answer(i)])),
      ...(Object.keys(annotations).length && { annotations }),
    })
  }

  return (
    <Sheet>
      <SheetHead {...props} label="Claude 在问你" />
      <div class="mt-2 space-y-5">
        <Index each={questions}>
          {(q, qi) => (
            <div>
              <p class="text-xs text-neutral-500">
                {q().header}
                {q().multiSelect ? ' · 可多选' : ''}
              </p>
              <h3 class="mt-0.5 font-medium">{q().question}</h3>
              <div class="mt-2 space-y-2">
                <For each={q().options}>
                  {(o) => {
                    const on = () => picked()[qi]!.includes(o.label)
                    return (
                      <button
                        onClick={() => pick(qi, o.label)}
                        aria-pressed={on()}
                        class={`flex w-full flex-col rounded-xl border px-3 py-2 text-left ${
                          on() ? 'border-sky-500 bg-sky-500/10' : 'border-neutral-700'
                        }`}
                      >
                        <span class="font-medium">
                          {q().multiSelect ? (on() ? '☑ ' : '☐ ') : ''}
                          {o.label}
                        </span>
                        <Show when={o.description}>
                          <span class="text-sm text-neutral-400">{o.description}</span>
                        </Show>
                      </button>
                    )
                  }}
                </For>
                <input
                  value={other()[qi]}
                  onInput={(e) => write(qi, e.currentTarget.value)}
                  placeholder={q().multiSelect ? '补充别的（可选）' : '都不是？自己写'}
                  class="w-full rounded-xl border border-neutral-700 bg-neutral-950 px-3 py-2 outline-none focus:border-neutral-500"
                />
              </div>
              <Show when={preview(qi)}>
                <pre class="mt-2 max-h-60 overflow-auto rounded-lg bg-neutral-950 p-3 font-mono text-xs whitespace-pre text-neutral-300">
                  {preview(qi)}
                </pre>
              </Show>
            </div>
          )}
        </Index>
      </div>
      <Show when={error()}>
        <p class="mt-2 text-sm text-red-400">{error()}</p>
      </Show>
      <div class="mt-4 grid grid-cols-2 gap-3">
        <button disabled={busy()} onClick={() => decide({ behavior: 'deny' })} class={secondary}>
          不回答
        </button>
        <button disabled={busy() || !ready()} onClick={submit} class={primary}>
          提交
        </button>
      </div>
    </Sheet>
  )
}
