import { createSignal, type ParentProps, Show } from 'solid-js'
import type { PermissionDecisionBody, PermissionRequest, PermissionUpdate } from '../../../shared/protocol'
import { errorText, MODE_LABEL, shortPath } from '../format'
import { DiffView, editHunks } from './Diff'

export interface SheetProps {
  req: PermissionRequest
  /** 后面还排着几个 */
  more: number
  onDecide: (d: PermissionDecisionBody) => Promise<unknown>
}

/** 底部弹层的外壳 */
export function Sheet(props: ParentProps) {
  return (
    <div class="fixed inset-x-0 bottom-0 z-20 mx-auto max-h-[88dvh] max-w-2xl overflow-y-auto rounded-t-2xl border-t border-neutral-700 bg-neutral-900 px-4 pt-4 pb-[max(1rem,env(safe-area-inset-bottom))] shadow-[0_-8px_30px_rgba(0,0,0,0.6)]">
      {props.children}
    </div>
  )
}

/** 发决定：成功后由 permission_resolved 事件关掉弹层，失败了留在弹层上显示 */
export function useDecide(props: SheetProps) {
  const [busy, setBusy] = createSignal(false)
  const [error, setError] = createSignal('')
  const decide = async (d: PermissionDecisionBody) => {
    setBusy(true)
    setError('')
    try {
      await props.onDecide(d)
    } catch (e) {
      setError(errorText(e))
    } finally {
      setBusy(false)
    }
  }
  return { busy, error, decide }
}

export function SheetHead(props: SheetProps & { label: string }) {
  return (
    <p class="text-xs text-amber-400">
      {props.label}
      {props.req.agentId ? ' · 子代理' : ''}
      {props.more > 0 ? ` · 后面还有 ${props.more} 个` : ''}
    </p>
  )
}

export const primary = 'rounded-xl bg-neutral-100 py-3 font-medium text-neutral-900 disabled:opacity-40'
export const secondary = 'rounded-xl border border-neutral-700 py-3 font-medium text-neutral-200 disabled:opacity-40'

/** 「本会话都允许」会加的规则，给人看的 */
function ruleText(u: PermissionUpdate): string {
  switch (u.type) {
    case 'addRules':
    case 'replaceRules':
      return u.rules.map((r) => (r.ruleContent ? `${r.toolName}(${r.ruleContent})` : r.toolName)).join('、')
    case 'addDirectories':
      return u.directories.map((d) => shortPath(d)).join('、')
    case 'setMode':
      return `切到${MODE_LABEL[u.mode]}模式`
    default:
      return ''
  }
}

function inputPreview(input: Record<string, unknown>): string {
  if (typeof input.command === 'string') return input.command
  const s = JSON.stringify(input, null, 2)
  return s.length > 3000 ? `${s.slice(0, 3000)}\n…` : s
}

/** 一般的权限请求：允许 / 本会话都允许 / 拒绝（可附一句话，Claude 会照着接着做） */
export function PermissionSheet(props: SheetProps) {
  const { busy, error, decide } = useDecide(props)
  const [reason, setReason] = createSignal('')
  const hunks = () => editHunks(props.req.toolName, props.req.input)
  const always = () =>
    props.req.suppressAlwaysAllowRule ? '' : (props.req.suggestions ?? []).map(ruleText).filter(Boolean).join('、')
  const note = () => [props.req.decisionReason, props.req.blockedPath].filter(Boolean).join(' · ')

  return (
    <Sheet>
      <SheetHead {...props} label="需要批准" />
      <h3 class="mt-1 font-medium">{props.req.title ?? `使用 ${props.req.displayName ?? props.req.toolName}`}</h3>
      <Show when={props.req.description}>
        <p class="mt-0.5 text-sm text-neutral-400">{props.req.description}</p>
      </Show>
      <Show
        when={hunks()}
        fallback={
          <pre class="mt-3 max-h-[40dvh] overflow-auto rounded-lg bg-neutral-950 p-3 font-mono text-xs whitespace-pre-wrap break-all text-neutral-200">
            {inputPreview(props.req.input)}
          </pre>
        }
      >
        {(h) => <DiffView hunks={h()} class="mt-3 max-h-[40dvh]" />}
      </Show>
      <Show when={note()}>
        <p class="mt-2 text-xs text-neutral-500">{note()}</p>
      </Show>
      <input
        value={reason()}
        onInput={(e) => setReason(e.currentTarget.value)}
        placeholder="拒绝时告诉 Claude 怎么做（可选）"
        class="mt-3 w-full rounded-lg border border-neutral-700 bg-neutral-950 px-3 py-2 outline-none focus:border-neutral-500"
      />
      <Show when={error()}>
        <p class="mt-2 text-sm text-red-400">{error()}</p>
      </Show>
      {/* defaultToNo：不能一下就批准，拒绝放在显眼的位置 */}
      <div class="mt-3 grid grid-cols-2 gap-3">
        <button
          disabled={busy()}
          onClick={() => decide({ behavior: 'deny', message: reason() })}
          class={props.req.defaultToNo ? primary : secondary}
        >
          {reason().trim() ? '拒绝并告诉它' : '拒绝'}
        </button>
        <button disabled={busy()} onClick={() => decide({ behavior: 'allow' })} class={props.req.defaultToNo ? secondary : primary}>
          允许
        </button>
      </div>
      <Show when={always()}>
        <button
          disabled={busy()}
          onClick={() => decide({ behavior: 'allow', always: true })}
          class="mt-3 flex w-full flex-col items-center rounded-xl border border-neutral-700 py-2 disabled:opacity-40"
        >
          <span class="text-sm font-medium text-neutral-200">本会话都允许</span>
          <span class="max-w-full truncate px-3 font-mono text-xs text-neutral-500">{always()}</span>
        </button>
      </Show>
    </Sheet>
  )
}
