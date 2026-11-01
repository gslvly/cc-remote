// 目录页的「文件」：这个目录里的子目录和文件。点子目录就地进去（不出这个目录），点文件全屏看（FileSheet）
import { createEffect, createMemo, createSignal, type Element, For, isPending, Loading, Show, untrack } from 'solid-js'
import type { FsList } from '../../../shared/protocol'
import { api } from '../api'
import { ago, dirCrumbs, errorText } from '../format'
import { afterPaint } from '../frame'
import { openFile } from './FileSheet'

const HIDDEN_KEY = 'ccr-files-hidden'
/** 各目录上次看到哪个子目录：进了会话再回来接着看 */
const places = new Map<string, string>()

/** 打开失败时 list 是上一个列表（没有就是 undefined），error 是原因 */
type Shown = { list?: FsList; error: string }

const ls = (path: string, hidden: boolean) =>
  api<FsList>(`/fs/ls?${new URLSearchParams({ path, files: '1', ...(hidden ? { hidden: '1' } : {}) })}`)

// 打不开时保留当前列表并显示错误；记住的子目录打不开（删了）就回到目录本身
async function open(root: string, path: string, hidden: boolean, prev?: FsList): Promise<Shown> {
  try {
    return { list: await ls(path, hidden), error: '' }
  } catch (e) {
    if (!prev && path !== root) return open(root, root, hidden)
    return { list: prev, error: errorText(e) }
  }
}

/** root：目录页的目录（真实路径）；tabs 放在标题行左边 */
export function DirFiles(props: { root: string; tabs: Element }) {
  const root = untrack(() => props.root)
  const [path, setPath] = createSignal(places.get(root) ?? root)
  const [hidden, setHidden] = createSignal(localStorage.getItem(HIDDEN_KEY) === '1')
  // 连点几下时 memo 只采用最后一次的结果
  const shown = createMemo((prev?: Shown) => open(root, path(), hidden(), prev?.list))
  let section!: HTMLElement
  let nav: HTMLElement | undefined

  const toggleHidden = () => {
    const on = !hidden()
    localStorage.setItem(HIDDEN_KEY, on ? '1' : '0')
    setPath(shown().list?.path ?? root)
    setHidden(on)
  }

  return (
    <section ref={section} class="mt-2 scroll-mt-4">
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
          {(cur) => {
            const trail = createMemo(() => dirCrumbs(root, cur().path ?? root))
            // 记住位置。进了子目录：列表顶上翻出去了就滚回来，面包屑长时横向滚到最右露出当前目录
            createEffect(
              () => cur().path,
              (p) => {
                if (p) places.set(root, p)
                afterPaint(() => {
                  if (section.getBoundingClientRect().top < 0) section.scrollIntoView()
                  if (nav) nav.scrollLeft = nav.scrollWidth
                })
              },
            )
            return (
              <div class="flex flex-col gap-2">
                <Show when={trail().length > 1}>
                  <nav ref={nav} class="flex items-center gap-1 overflow-x-auto text-sm whitespace-nowrap [scrollbar-width:none]">
                    <For each={trail()}>
                      {(c, i) => (
                        <Show when={i() < trail().length - 1} fallback={<span class="px-1 font-medium">{c.label}</span>}>
                          <button onClick={() => setPath(c.path)} class="rounded px-1 py-1 text-neutral-400 active:bg-neutral-800">
                            {c.label}
                          </button>
                          <span class="text-neutral-600">/</span>
                        </Show>
                      )}
                    </For>
                  </nav>
                </Show>
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
                          <button onClick={() => setPath(e.path)} class="flex w-full items-center gap-2 px-3 py-2.5 text-left">
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
            )
          }}
        </Show>
      </Loading>
    </section>
  )
}
