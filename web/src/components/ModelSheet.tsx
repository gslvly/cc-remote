import { createSignal, Errored, For, Loading, Show, untrack } from 'solid-js'
import type { Catalog, EffortLevel, SessionInfo, SetModelBody } from '../../../shared/protocol'
import { cachedGet } from '../api'
import { errorText } from '../format'
import { Sheet } from './PermissionSheet'

/** 去掉 [1m] 这类后缀再比：列表里的 value 带，init 报的 id 不一定带 */
const bare = (id?: string) => id?.replace(/\[.*\]$/, '')

const chip = (on: boolean) =>
  `rounded-full border px-3 py-1 text-sm disabled:opacity-40 ${on ? 'border-neutral-300 text-neutral-100' : 'border-neutral-700 text-neutral-400'}`

/**
 * 切模型、effort（终端里的 /model、/effort），只对本会话，子进程回收后续接也接着用。点页头的模型那一行弹出。
 * 列表是 Claude Code 自己给的（supportedModels），effort 按当前模型支持的档位
 */
export function ModelSheet(props: { info: SessionInfo; onSet: (b: SetModelBody) => Promise<unknown>; onClose: () => void }) {
  const cat = cachedGet<Catalog>(`/catalog?cwd=${encodeURIComponent(untrack(() => props.info.cwd))}`)
  const [busy, setBusy] = createSignal(false)
  const [error, setError] = createSignal('')
  const set = async (b: SetModelBody) => {
    setBusy(true)
    setError('')
    try {
      await props.onSet(b)
    } catch (e) {
      setError(errorText(e))
    } finally {
      setBusy(false)
    }
  }
  const isCurrent = (resolved?: string) => !!resolved && bare(resolved) === bare(props.info.model)
  const efforts = () => cat().models.find((m) => isCurrent(m.resolved))?.efforts ?? []

  return (
    <>
      <div class="fixed inset-0 z-20 bg-black/40" onClick={() => props.onClose()} />
      <Sheet>
        <div class="flex items-center justify-between">
          <h2 class="font-medium">模型</h2>
          <button onClick={() => props.onClose()} class="-mr-2 px-2 text-sm text-neutral-400">
            完成
          </button>
        </div>
        <Errored fallback={(err) => <p class="mt-2 text-sm text-red-400">{errorText(err())}</p>}>
          <Loading fallback={<p class="mt-2 text-sm text-neutral-500">取模型列表…</p>}>
            <div class="mt-2 space-y-1">
              <For each={cat().models}>
                {(m) => (
                  <button
                    disabled={busy()}
                    onClick={() => set({ model: m.value })}
                    class={`block w-full rounded-lg px-3 py-2 text-left disabled:opacity-60 ${isCurrent(m.resolved) ? 'bg-neutral-800' : ''}`}
                  >
                    <span class="text-sm text-neutral-200">{m.displayName}</span>
                    <span class="block text-xs text-neutral-500">{m.description}</span>
                  </button>
                )}
              </For>
            </div>
            <Show when={efforts().length}>
              <h2 class="mt-4 font-medium">effort</h2>
              <div class="mt-2 flex flex-wrap gap-2">
                <For each={efforts()}>
                  {(e: EffortLevel) => (
                    <button disabled={busy()} onClick={() => set({ effort: e })} class={chip(props.info.effort === e)}>
                      {e}
                    </button>
                  )}
                </For>
                <button disabled={busy()} onClick={() => set({ effort: null })} class={chip(false)}>
                  默认
                </button>
              </div>
            </Show>
          </Loading>
        </Errored>
        <Show when={error()}>
          <p class="mt-2 text-sm text-red-400">{error()}</p>
        </Show>
      </Sheet>
    </>
  )
}
