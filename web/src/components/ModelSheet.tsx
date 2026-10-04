import { createSignal, Errored, For, Loading, Show, untrack } from 'solid-js'
import type { Catalog, CatalogModel, EffortLevel, PermissionMode, SwitchableMode } from '../../../shared/protocol'
import { cachedGet } from '../api'
import { errorText, MODE_BORDER, MODE_LABEL, MODE_TEXT, MODES } from '../format'
import { Sheet } from './PermissionSheet'

/** 去掉 [1m] 这类后缀再比：列表里的 value 带，init 报的 id 不一定带 */
const bare = (id?: string) => id?.replace(/\[.*\]$/, '')

const chip = (on: boolean) =>
  `rounded-full border px-3 py-1 text-sm disabled:opacity-40 ${on ? 'border-neutral-300 text-neutral-100' : 'border-neutral-700 text-neutral-400'}`

/** 选中的模式用它的颜色（默认模式没有颜色，同 effort） */
const modeChip = (m: PermissionMode, on: boolean) =>
  on && MODE_TEXT[m] ? `rounded-full border px-3 py-1 text-sm ${MODE_BORDER[m]} ${MODE_TEXT[m]}` : chip(on)

/**
 * 切模型、effort（终端里的 /model、/effort）、权限模式（Shift+Tab）。列表是 Claude Code 自己给的（supportedModels），
 * effort 按当前模型支持的档位。会话页点页头的模型或模式弹出，只对本会话，子进程回收后续接也接着用；
 * 目录页（draft）给还没开的会话选，模型、模式多一项「本机默认」（不传，由 Claude Code 自己定）
 */
export function ModelSheet(props: {
  cwd: string
  /** 会话页：正在用的模型 id（与列表的 resolved 比）；目录页：选的那项的 value，没选是本机默认 */
  model?: string
  effort?: string
  mode?: PermissionMode
  draft?: boolean
  /** 下面三个给 undefined 是回到默认；模型、模式只有 draft 时才会 */
  onModel: (value: string | undefined) => unknown
  onEffort: (effort: EffortLevel | undefined) => unknown
  onMode: (mode: SwitchableMode | undefined) => unknown
  onClose: () => void
}) {
  const cat = cachedGet<Catalog>(`/catalog?cwd=${encodeURIComponent(untrack(() => props.cwd))}`)
  const [busy, setBusy] = createSignal(false)
  const [error, setError] = createSignal('')
  const act = async (fn: () => unknown) => {
    setBusy(true)
    setError('')
    try {
      await fn()
    } catch (e) {
      setError(errorText(e))
    } finally {
      setBusy(false)
    }
  }
  const extraMode = () => {
    const m = props.mode
    return m && !(MODES as PermissionMode[]).includes(m) ? m : undefined
  }
  const isCurrent = (m: CatalogModel) =>
    props.draft ? m.value === props.model : !!m.resolved && bare(m.resolved) === bare(props.model)
  // 目录页没选模型时按 default 那项（推荐的）给档位
  const efforts = () =>
    (cat().models.find(isCurrent) ?? (props.draft ? cat().models.find((m) => m.value === 'default') : undefined))?.efforts ?? []

  const row = (on: () => boolean, name: string, description: string, pick: () => unknown) => (
    <button
      disabled={busy()}
      onClick={() => act(pick)}
      class={`block w-full rounded-lg px-3 py-2 text-left disabled:opacity-60 ${on() ? 'bg-neutral-800' : ''}`}
    >
      <span class="text-sm text-neutral-200">{name}</span>
      <span class="block text-xs text-neutral-500">{description}</span>
    </button>
  )

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
              <Show when={props.draft}>
                {row(() => !props.model, '本机默认', '按本机 Claude Code 的设置', () => props.onModel(undefined))}
              </Show>
              <For each={cat().models}>
                {(m) => row(() => isCurrent(m), m.displayName, m.description, () => props.onModel(m.value))}
              </For>
            </div>
            <Show when={efforts().length}>
              <h2 class="mt-4 font-medium">effort</h2>
              <div class="mt-2 flex flex-wrap gap-2">
                <For each={efforts()}>
                  {(e: EffortLevel) => (
                    <button disabled={busy()} onClick={() => act(() => props.onEffort(e))} class={chip(props.effort === e)}>
                      {e}
                    </button>
                  )}
                </For>
                {/* 会话页的 effort 是问来的实际值，分不出是不是默认，不标 */}
                <button disabled={busy()} onClick={() => act(() => props.onEffort(undefined))} class={chip(!!props.draft && !props.effort)}>
                  默认
                </button>
              </div>
            </Show>
          </Loading>
        </Errored>
        <h2 class="mt-4 font-medium">权限模式</h2>
        <div role="group" aria-label="权限模式" class="mt-2 flex flex-wrap gap-2">
          <Show when={props.draft}>
            <button disabled={busy()} onClick={() => act(() => props.onMode(undefined))} class={chip(!props.mode)}>
              本机默认
            </button>
          </Show>
          <For each={MODES}>
            {(m) => (
              <button disabled={busy()} onClick={() => act(() => props.onMode(m))} class={modeChip(m, props.mode === m)}>
                {MODE_LABEL[m]}
              </button>
            )}
          </For>
          {/* 跳过审批这类手机上切不进去的：正处在它时也显示出来 */}
          <Show when={extraMode()}>
            {(m) => (
              <button disabled class={modeChip(m(), true)}>
                {MODE_LABEL[m()]}
              </button>
            )}
          </Show>
        </div>
        <Show when={error()}>
          <p class="mt-2 text-sm text-red-400">{error()}</p>
        </Show>
      </Sheet>
    </>
  )
}
