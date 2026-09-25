import { createEffect, createSignal, on, Show } from 'solid-js'
import type { PermissionMode, SessionState, SwitchableMode } from '../../../shared/protocol'
import { errorText } from '../format'
import { ModeSelect } from './ModeSelect'

export function Composer(props: {
  state: SessionState
  mode?: PermissionMode
  onSend: (text: string) => Promise<unknown>
  onInterrupt: () => Promise<unknown>
  onMode: (mode: SwitchableMode) => Promise<unknown>
}) {
  const [text, setText] = createSignal('')
  const [busy, setBusy] = createSignal(false)
  const [error, setError] = createSignal('')
  let input: HTMLTextAreaElement | undefined

  const busyState = () => props.state === 'starting' || props.state === 'running' || props.state === 'requires_action'
  const showStop = () => busyState() && !text().trim()

  // 输入框随内容长高，最多 160px
  createEffect(
    on(text, () => {
      if (!input) return
      input.style.height = 'auto'
      input.style.height = `${Math.min(input.scrollHeight, 160)}px`
    }),
  )

  const run = async (fn: () => Promise<unknown>, clear: boolean) => {
    setBusy(true)
    setError('')
    try {
      await fn()
      if (clear) setText('')
    } catch (e) {
      setError(errorText(e))
    } finally {
      setBusy(false)
    }
  }

  const submit = () => {
    if (showStop()) return run(props.onInterrupt, false)
    const t = text()
    if (t.trim()) return run(() => props.onSend(t), true)
  }

  return (
    <div class="border-t border-neutral-800 bg-neutral-950 px-3 pt-2 pb-[max(0.5rem,env(safe-area-inset-bottom))]">
      <Show when={error()}>
        <p class="px-1 pb-1 text-xs text-red-400">{error()}</p>
      </Show>
      <div class="flex items-end gap-2">
        <ModeSelect
          value={props.mode}
          unset="模式"
          onChange={(m) => m && run(() => props.onMode(m), false)}
          class="h-10 max-w-24 shrink-0"
        />
        <textarea
          ref={input}
          rows={1}
          value={text()}
          onInput={(e) => setText(e.currentTarget.value)}
          // Enter 发送，Shift/Option+Enter 换行；输入法选词时的 Enter 不算
          onKeyDown={(e) => {
            if (e.key !== 'Enter' || e.shiftKey || e.isComposing || e.keyCode === 229) return
            e.preventDefault()
            if (e.altKey) {
              // Option+Enter 浏览器不一定插换行，手动插
              const el = e.currentTarget
              el.setRangeText('\n', el.selectionStart, el.selectionEnd, 'end')
              setText(el.value)
            } else if (!busy()) void submit()
          }}
          enterkeyhint="send"
          placeholder={busyState() ? '排队发给 Claude…' : '继续对话…'}
          class="min-h-10 flex-1 resize-none rounded-2xl border border-neutral-700 bg-neutral-900 px-3.5 py-2 text-base leading-6 outline-none focus:border-neutral-500"
        />
        <button
          onClick={() => void submit()}
          disabled={busy() || (!showStop() && !text().trim())}
          aria-label={showStop() ? '中断' : '发送'}
          class={`grid size-10 shrink-0 place-items-center rounded-full text-lg disabled:opacity-30 ${
            showStop() ? 'bg-red-500/90 text-white' : 'bg-neutral-100 text-neutral-900'
          }`}
        >
          {showStop() ? '■' : '↑'}
        </button>
      </div>
    </div>
  )
}
