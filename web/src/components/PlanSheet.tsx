import { createSignal, Show } from 'solid-js'
import { shortPath } from '../format'
import { Markdown } from './Markdown'
import { type SheetProps, Sheet, SheetHead, primary, secondary, useDecide } from './PermissionSheet'

/**
 * ExitPlanMode：计划全文 + 批准。与终端的选项对应：自动接受编辑 / 逐个审批，
 * 批准时同时切到那个模式；不批准时写了话就继续规划（话转给 Claude），没写就停下这一轮。
 * 计划正文是 CLI 从计划文件读出来补进 input 的（input.plan、input.planFilePath）
 */
export function PlanSheet(props: SheetProps) {
  const { busy, error, decide } = useDecide(props)
  const [feedback, setFeedback] = createSignal('')
  const plan = typeof props.req.input.plan === 'string' ? props.req.input.plan : ''
  const file = typeof props.req.input.planFilePath === 'string' ? props.req.input.planFilePath : ''

  return (
    <Sheet>
      <SheetHead {...props} label="计划待批准" />
      <div class="mt-2 max-h-[48dvh] overflow-y-auto rounded-lg bg-neutral-950 p-3">
        <Markdown text={plan || '（没有收到计划正文）'} class="text-sm" />
      </div>
      <Show when={file}>
        <p class="mt-1 truncate font-mono text-xs text-neutral-600">{shortPath(file)}</p>
      </Show>
      <Show when={error()}>
        <p class="mt-2 text-sm text-red-400">{error()}</p>
      </Show>
      <div class="mt-3 grid grid-cols-2 gap-3">
        <button disabled={busy()} onClick={() => decide({ behavior: 'allow', mode: 'acceptEdits' })} class={primary}>
          批准，自动接受编辑
        </button>
        <button disabled={busy()} onClick={() => decide({ behavior: 'allow', mode: 'default' })} class={secondary}>
          批准，逐个审批
        </button>
      </div>
      <div class="mt-3 flex items-end gap-2 border-t border-neutral-800 pt-3">
        <textarea
          value={feedback()}
          onInput={(e) => setFeedback(e.currentTarget.value)}
          rows={2}
          placeholder="要改什么？写了就接着规划"
          class="min-w-0 flex-1 resize-none rounded-xl border border-neutral-700 bg-neutral-950 px-3 py-2 outline-none focus:border-neutral-500"
        />
        <button
          disabled={busy()}
          onClick={() => decide({ behavior: 'deny', message: feedback() })}
          class="shrink-0 rounded-xl border border-neutral-700 px-3 py-2 text-sm font-medium text-neutral-200 disabled:opacity-40"
        >
          {feedback().trim() ? '继续规划' : '不批准'}
        </button>
      </div>
    </Sheet>
  )
}
