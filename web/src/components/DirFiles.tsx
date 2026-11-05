// 目录页的「文件」：这个目录里的子目录和文件。点子目录进它的目录页，点文件全屏看（FileSheet）
import { createMemo, createSignal, type Element, For, isPending, Loading, Show, untrack } from 'solid-js'
import type { FsList } from '../../../shared/protocol'
import { api } from '../api'
import { ago, errorText } from '../format'
import { go } from '../router'
import { openFile } from './FileSheet'

const HIDDEN_KEY = 'ccr-files-hidden'

/** 打不开时 list 是上一个列表（没有就是 undefined），error 是原因 */
type Shown = { list?: FsList; error: string }

const ls = (path: string, hidden: boolean) =>
  api<FsList>(`/fs/ls?${new URLSearchParams({ path, files: '1', ...(hidden ? { hidden: '1' } : {}) })}`)

// 切「显示隐藏」时打不开就保留当前列表并显示错误
async function open(path: string, hidden: boolean, prev?: FsList): Promise<Shown> {
  try {
    return { list: await ls(path, hidden), error: '' }
  } catch (e) {
    return { list: prev, error: errorText(e) }
  }
}

/** path：目录页的目录（真实路径）；tabs 放在标题行左边 */
export function DirFiles(props: { path: string; tabs: Element }) {
  const path = untrack(() => props.path)
  const [hidden, setHidden] = createSignal(localStorage.getItem(HIDDEN_KEY) === '1')
  // 连点几下时 memo 只采用最后一次的结果
  const shown = createMemo((prev?: Shown) => open(path, hidden(), prev?.list))

  const toggleHidden = () => {
    const on = !hidden()
    localStorage.setItem(HIDDEN_KEY, on ? '1' : '0')
    setHidden(on)
  }

  return (
    <section class="mt-2">
      <div class="mb-2 flex items-center justify-between">
        {props.tabs}
        <button
          onClick={toggleHidden}
          aria-pressed={hidden() ? 'true' : 'false'}
          class={`-my-2 -mr-2 px-2 py-2 text-xs ${hidden() ? 'text-neutral-200' : 'text-neutral-500'}`}
        >
          显示隐藏
        </button>
      </div>
      <Loading fallback={<p class="py-2 text-sm text-neutral-500">加载中…</p>}>
        <Show when={shown().list} fallback={<p class="text-sm text-red-400">{shown().error}</p>}>
          {(cur) => (
            <div class="flex flex-col gap-2">
              <Show when={shown().error}>{(error) => <p class="text-sm text-red-400">{error()}</p>}</Show>
              <Show
                when={cur().entries.length || cur().files?.length}
                fallback={<p class="py-4 text-center text-sm text-neutral-500">空文件夹</p>}
              >
                <ul
                  class={`divide-y divide-neutral-800 rounded-xl border border-neutral-800 transition-opacity ${
                    isPending(() => shown()) ? 'opacity-50' : ''
                  }`}
                >
                  <For each={cur().entries}>
                    {(e) => (
                      <li>
                        <button onClick={() => go.dir(e.path)} class="flex w-full items-center gap-2 px-3 py-2.5 text-left">
                          <span class="min-w-0 flex-1 truncate">{e.name}</span>
                          <span class="text-neutral-600">›</span>
                        </button>
                      </li>
                    )}
                  </For>
                  {/* 文件排在目录后面，右边是修改时间，好找刚改过的 */}
                  <For each={cur().files}>
                    {(f) => (
                      <li>
                        <button onClick={() => openFile(f.path)} class="flex w-full items-center gap-2 px-3 py-2.5 text-left">
                          <span class="min-w-0 flex-1 truncate text-neutral-300">{f.name}</span>
                          <span class="shrink-0 text-xs text-neutral-500">{ago(f.mtime)}</span>
                        </button>
                      </li>
                    )}
                  </For>
                </ul>
              </Show>
            </div>
          )}
        </Show>
      </Loading>
    </section>
  )
}
