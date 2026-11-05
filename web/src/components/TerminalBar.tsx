import { createSignal, Show } from 'solid-js'
import type { SessionState } from '../../../shared/protocol'
import { errorText } from '../format'

/** 接管前的确认里都要说的：接管会关掉电脑终端里的 claude，怎么接回去 */
export const BACK_TO_TERMINAL = '回电脑后在同一个目录运行 claude -c 接回来。'

/**
 * 终端占着、正在跑（或在等人操作）的会话的底栏，代替输入框：两边同时写会分叉，只能等它停下或打断并接管。
 * 终端空闲时页面换成输入框（发消息就接管，见 Composer 的 takeover）；终端退出、被接管后服务端推来的 info 不再带 terminal，就是历史会话
 */
export function TerminalBar(props: { state: SessionState; onTakeover: () => Promise<unknown> }) {
  const [busy, setBusy] = createSignal(false)
  const [error, setError] = createSignal('')
  const takeover = async () => {
    const doing = props.state === 'requires_action' ? '终端里等着的操作会作废' : '会打断终端里正在跑的这一轮'
    if (!confirm(`${doing}，关掉电脑终端里的 claude，接到手机上。\n${BACK_TO_TERMINAL}`)) return
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
        <p class="pb-1 text-xs text-red-400">{error()}</p>
      </Show>
      <div class="flex items-center gap-3">
        <p class="flex-1 py-1.5 text-sm text-neutral-400">
          ▣ {props.state === 'requires_action' ? '终端里在等人操作' : '终端里正在跑这个会话'}
        </p>
        <button
          onClick={() => void takeover()}
          disabled={busy()}
          class="shrink-0 rounded-full border border-neutral-700 px-3 py-1.5 text-sm text-neutral-200 disabled:opacity-40"
        >
          {busy() ? '接管中…' : '打断并接管'}
        </button>
      </div>
    </div>
  )
}
