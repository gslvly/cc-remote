import { createMemo, createSignal, Errored, For, Loading, Show } from 'solid-js'
import type { RewindRestore, RewindResult } from '../../../shared/protocol'
import { errorText, shortPath } from '../format'
import { primary, secondary, Sheet } from './PermissionSheet'

/**
 * 回退到某条用户消息之前（终端里按两下 Esc）：先预览代码要还原哪些文件、对话能不能回退，
 * 再选代码和对话一起、只回退对话、只还原代码（同终端的回退菜单）。回退了对话的，这条的原文放回输入框。
 * 点用户消息下面的「回退到这里」弹出
 */
export function RewindSheet(props: {
  text: string
  cwd: string
  preview: () => Promise<RewindResult>
  onRewind: (restore: RewindRestore) => Promise<unknown>
  onClose: () => void
}) {
  const plan = createMemo(() => props.preview())
  const [busy, setBusy] = createSignal(false)
  const [error, setError] = createSignal('')
  const rewind = async (restore: RewindRestore) => {
    setBusy(true)
    setError('')
    try {
      await props.onRewind(restore)
    } catch (e) {
      setError(errorText(e))
    } finally {
      setBusy(false)
    }
  }
  const rel = (p: string) => (p.startsWith(`${props.cwd}/`) ? p.slice(props.cwd.length + 1) : shortPath(p))
  const files = () => plan().files
  /** 有要还原的文件（这条之后没改过文件的，还原代码没意义） */
  const code = () => !!files()?.canRewind && !!files()?.filesChanged?.length
  const talk = () => !plan().conversationBlocked
  const choices = (): { restore: RewindRestore; label: string }[] => [
    ...(code() && talk() ? [{ restore: 'both' as const, label: '代码和对话都回退' }] : []),
    ...(talk() ? [{ restore: 'conversation' as const, label: '只回退对话' }] : []),
    ...(code() ? [{ restore: 'code' as const, label: '只还原代码' }] : []),
  ]

  return (
    <>
      <div class="fixed inset-0 z-20 bg-black/40" onClick={() => props.onClose()} />
      <Sheet>
        <div class="flex items-center justify-between">
          <h2 class="font-medium">回退到这条之前</h2>
          <button onClick={() => props.onClose()} class="-mr-2 px-2 text-sm text-neutral-400">
            取消
          </button>
        </div>
        <p class="mt-2 line-clamp-3 rounded-lg bg-neutral-800 px-3 py-2 text-sm whitespace-pre-wrap text-neutral-300">{props.text}</p>
        <Errored fallback={(err) => <p class="mt-3 text-sm text-red-400">{errorText(err())}</p>}>
          <Loading fallback={<p class="mt-3 text-sm text-neutral-500">看看要还原哪些文件…</p>}>
            <div class="mt-3 space-y-2 text-sm">
              <div>
                <span class="text-neutral-500">代码：</span>
                <Show
                  when={files()?.canRewind}
                  fallback={<span class="text-amber-400">还原不了（{files()?.error || '这条没留底'}）</span>}
                >
                  <Show when={files()?.filesChanged?.length} fallback={<span class="text-neutral-400">这条之后没改过文件</span>}>
                    <span class="text-neutral-300">还原 {files()!.filesChanged!.length} 个文件</span>
                    <span class="ml-2 font-mono">
                      <span class="text-emerald-500">+{files()!.insertions ?? 0}</span>
                      <span class="ml-1 text-red-400">−{files()!.deletions ?? 0}</span>
                    </span>
                    <ul class="mt-1 space-y-0.5 font-mono text-xs text-neutral-400">
                      <For each={files()!.filesChanged}>{(f) => <li class="truncate">{rel(f)}</li>}</For>
                    </ul>
                  </Show>
                </Show>
              </div>
              <div>
                <span class="text-neutral-500">对话：</span>
                <Show when={plan().conversationBlocked} fallback={<span class="text-neutral-300">回到这条之前，原文放回输入框</span>}>
                  {(why) => <span class="text-amber-400">{why()}</span>}
                </Show>
              </div>
            </div>
            <div class="mt-4 flex flex-col gap-2">
              <For each={choices()} fallback={<p class="text-sm text-neutral-500">没有可回退的</p>}>
                {(c, i) => (
                  <button onClick={() => void rewind(c.restore)} disabled={busy()} class={i() === 0 ? primary : secondary}>
                    {c.label}
                  </button>
                )}
              </For>
            </div>
          </Loading>
        </Errored>
        <Show when={error()}>
          <p class="mt-2 text-sm text-red-400">{error()}</p>
        </Show>
      </Sheet>
    </>
  )
}
