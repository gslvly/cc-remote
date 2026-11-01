import { createSignal, For, Show } from 'solid-js'
import type { QueuedInput } from '../../../shared/protocol'
import { errorText } from '../format'

/**
 * 发了、Claude 还没收进去的消息（同终端里排在输入框上面的那些）：调暗，放在输入框上面。
 * 收进去之后就从这里消失，出现在对话流里 Claude 看到它的位置。立即发送会中断手上这一步，接着把它发出去
 */
export function QueuedBox(props: { queued: QueuedInput[]; onSendNow: (uuid: string) => Promise<unknown> }) {
  const [sending, setSending] = createSignal(false)
  const [error, setError] = createSignal('')
  const sendNow = async (uuid: string) => {
    setSending(true)
    setError('')
    try {
      await props.onSendNow(uuid)
    } catch (e) {
      setError(errorText(e))
    } finally {
      setSending(false)
    }
  }
  return (
    <div class="mx-4 mb-1">
      <For each={props.queued}>
        {(q) => (
          <div class="flex items-baseline gap-3 py-0.5">
            <p class="line-clamp-2 min-w-0 flex-1 text-sm whitespace-pre-wrap wrap-anywhere text-neutral-500">
              <Show when={q.images}>{(n) => <span class="text-neutral-600">［{n()} 张图片］</span>}</Show>
              {q.text}
            </p>
            <button
              onClick={() => void sendNow(q.uuid)}
              disabled={sending()}
              class="shrink-0 text-xs text-neutral-400 disabled:opacity-40"
            >
              立即发送
            </button>
          </div>
        )}
      </For>
      <Show when={error()}>
        <p class="py-0.5 text-xs text-red-400">{error()}</p>
      </Show>
    </div>
  )
}
