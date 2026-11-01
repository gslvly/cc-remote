import { createSignal, Show } from 'solid-js'
import { errorText } from '../format'
import { primary, Sheet } from './PermissionSheet'

/**
 * 压缩上下文（终端里的 /compact）：点状态栏的「上下文」弹出，不用在输入框里打命令。
 * 要求可不填，填了就是 /compact <要求>。Claude 正在干活时发出去会排在这一轮之后
 */
export function CompactSheet(props: {
  /** 上下文用量，如「45% · 450k / 1M」 */
  usage: string
  busy: boolean
  compacting: boolean
  onCompact: (instructions: string) => Promise<unknown>
  onClose: () => void
}) {
  const [text, setText] = createSignal('')
  const [sending, setSending] = createSignal(false)
  const [error, setError] = createSignal('')
  const compact = async () => {
    setSending(true)
    setError('')
    try {
      await props.onCompact(text().trim())
    } catch (e) {
      setError(errorText(e))
    } finally {
      setSending(false)
    }
  }

  return (
    <>
      <div class="fixed inset-0 z-20 bg-black/40" onClick={() => props.onClose()} />
      <Sheet>
        <div class="flex items-center justify-between">
          <h2 class="font-medium">压缩上下文</h2>
          <button onClick={() => props.onClose()} class="-mr-2 px-2 text-sm text-neutral-400">
            取消
          </button>
        </div>
        <p class="mt-1 text-xs text-neutral-500 tabular-nums">上下文 {props.usage}</p>
        <textarea
          rows={2}
          value={text()}
          onInput={(e) => setText(e.currentTarget.value)}
          placeholder="要特别保留什么（可不填）"
          class="mt-3 w-full resize-none rounded-lg border border-neutral-700 bg-neutral-950 px-3 py-2 text-base outline-none focus:border-neutral-500"
        />
        <Show when={props.busy && !props.compacting}>
          <p class="mt-1 text-xs text-neutral-500">Claude 正在干活，压缩排在这一轮之后</p>
        </Show>
        <Show when={error()}>
          <p class="mt-1 text-sm text-red-400">{error()}</p>
        </Show>
        <button onClick={() => void compact()} disabled={sending() || props.compacting} class={`mt-3 w-full ${primary}`}>
          {props.compacting ? '压缩中…' : '压缩'}
        </button>
      </Sheet>
    </>
  )
}
