import { createSignal, Show } from 'solid-js'
import type { SessionInfo } from '../../../shared/protocol'
import { errorText } from '../format'

/**
 * 终端会话的底栏，代替输入框：终端进程还在就只读（两边同时写会分叉）；
 * 终端退出后可以接管，接管后就是普通的托管会话，发消息时 resume
 */
export function TerminalBar(props: { info: SessionInfo; onTakeover: () => Promise<unknown> }) {
  const [busy, setBusy] = createSignal(false)
  const [error, setError] = createSignal('')

  const takeover = async () => {
    setBusy(true)
    setError('')
    try {
      await props.onTakeover()
    } catch (e) {
      setError(errorText(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div class="border-t border-neutral-800 bg-neutral-950 px-4 pt-2.5 pb-[max(0.75rem,env(safe-area-inset-bottom))]">
      <Show when={error()}>
        <p class="pb-1.5 text-xs text-red-400">{error()}</p>
      </Show>
      <Show
        when={props.info.terminal === 'exited'}
        fallback={<p class="py-1.5 text-sm text-neutral-400">▣ 终端里正在用这个会话，手机上只能看</p>}
      >
        <div class="flex items-center gap-3">
          <p class="min-w-0 flex-1 text-sm text-neutral-400">终端已退出，接管后可以在手机上接着聊</p>
          <button
            onClick={() => void takeover()}
            disabled={busy()}
            class="shrink-0 rounded-xl bg-neutral-100 px-4 py-2 font-medium text-neutral-900 disabled:opacity-40"
          >
            {busy() ? '接管中…' : '接管'}
          </button>
        </div>
      </Show>
    </div>
  )
}
