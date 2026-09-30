import { createEffect, createMemo, createSignal, For, isPending, Loading, Show } from 'solid-js'
import type { FsList } from '../../../shared/protocol'
import { api } from '../api'
import { basename, crumbs, errorText, rootLabel } from '../format'
import { afterPaint } from '../frame'
import { go } from '../router'

// 上次浏览到的目录、是否显示隐藏目录，下次打开接着用
const PATH_KEY = 'ccr-browse-path'
const HIDDEN_KEY = 'ccr-browse-hidden'

type Target = { path: string | null; hidden: boolean }
/** 打开失败时 list 是上一个列表（没有就是 undefined），error 是原因 */
type Shown = { list?: FsList; error: string }

const ls = (to: Target) => {
  const q = new URLSearchParams()
  if (to.path) q.set('path', to.path)
  if (to.hidden) q.set('hidden', '1')
  return api<FsList>(`/fs/ls?${q}`)
}

// 打不开时保留当前列表并显示错误；记住的位置打不开（删了、不在 roots 内）就回到顶层
const open = async (to: Target, prev?: FsList): Promise<Shown> => {
  try {
    return { list: await ls(to), error: '' }
  } catch (e) {
    if (!prev && to.path) return open({ ...to, path: null })
    return { list: prev, error: errorText(e) }
  }
}

export function DirBrowser(props: { favorites: Set<string> }) {
  const [target, setTarget] = createSignal<Target>({
    path: localStorage.getItem(PATH_KEY),
    hidden: localStorage.getItem(HIDDEN_KEY) === '1',
  })
  const [filter, setFilter] = createSignal('')
  // 连点几下时 memo 只采用最后一次的结果
  const shown = createMemo((prev?: Shown) => open(target(), prev?.list))
  let nav: HTMLElement | undefined

  const enter = (path: string | null) => {
    setFilter('')
    setTarget({ path, hidden: target().hidden })
  }

  const toggleHidden = () => {
    const hidden = !target().hidden
    localStorage.setItem(HIDDEN_KEY, hidden ? '1' : '0')
    setTarget({ path: shown().list?.path ?? null, hidden })
  }

  const entries = () => {
    const q = filter().trim().toLowerCase()
    const all = shown().list?.entries ?? []
    return q ? all.filter((e) => e.name.toLowerCase().includes(q)) : all
  }

  return (
    <Loading fallback={<p class="text-sm text-neutral-500">加载中…</p>}>
      <Show when={shown().list} fallback={<p class="text-sm text-red-400">{shown().error}</p>}>
        {(cur) => {
          const trail = createMemo(() => crumbs(cur()))
          // 记住位置；路径长时面包屑横向滚到最右，露出当前目录。等新目录画出来再滚，见 afterPaint
          createEffect(
            () => cur().path,
            (path) => {
              if (path) localStorage.setItem(PATH_KEY, path)
              else localStorage.removeItem(PATH_KEY)
              afterPaint(() => nav && (nav.scrollLeft = nav.scrollWidth))
            },
          )
          return (
            <div class="flex flex-col gap-3">
              <nav ref={nav} class="flex items-center gap-1 overflow-x-auto text-sm whitespace-nowrap [scrollbar-width:none]">
                <For each={trail()}>
                  {(c, i) => (
                    <Show when={i() < trail().length - 1} fallback={<span class="px-1 font-medium">{c.label}</span>}>
                      <span class="flex items-center gap-1">
                        <button onClick={() => enter(c.path)} class="rounded px-1 py-0.5 text-neutral-400 active:bg-neutral-800">
                          {c.label}
                        </button>
                        <span class="text-neutral-600">/</span>
                      </span>
                    </Show>
                  )}
                </For>
                <Show when={cur().branch}>
                  <span class="ml-1 shrink-0 font-mono text-xs text-neutral-500">⎇ {cur().branch}</span>
                </Show>
              </nav>

              <div class="flex gap-2">
                <input
                  type="search"
                  value={filter()}
                  onInput={(e) => setFilter(e.currentTarget.value)}
                  onKeyDown={(e) => {
                    const first = entries()[0]
                    if (e.key === 'Enter' && first) enter(first.path)
                  }}
                  enterkeyhint="go"
                  placeholder="过滤"
                  autocapitalize="off"
                  autocorrect="off"
                  class="min-w-0 flex-1 rounded-lg border border-neutral-800 bg-neutral-900 px-3 py-1.5 outline-none focus:border-neutral-600"
                />
                <button
                  onClick={toggleHidden}
                  aria-pressed={target().hidden ? 'true' : 'false'}
                  class={`shrink-0 rounded-lg border px-3 text-sm ${
                    target().hidden ? 'border-neutral-500 bg-neutral-800 text-neutral-100' : 'border-neutral-800 text-neutral-500'
                  }`}
                >
                  显示隐藏
                </button>
              </div>

              <Show when={shown().error}>
                <p class="text-sm text-red-400">{shown().error}</p>
              </Show>

              <Show
                when={entries().length}
                fallback={
                  <p class="py-4 text-center text-sm text-neutral-500">{filter().trim() ? '没有匹配的目录' : '没有子目录'}</p>
                }
              >
                <ul
                  class={`divide-y divide-neutral-800 rounded-xl border border-neutral-800 transition-opacity ${
                    isPending(() => shown()) ? 'opacity-50' : ''
                  }`}
                >
                  <For each={entries()}>
                    {(e) => (
                      <li>
                        <button onClick={() => enter(e.path)} class="flex w-full items-center gap-2 px-3 py-2.5 text-left">
                          <span class="min-w-0 flex-1 truncate">{cur().path ? e.name : rootLabel(e.path)}</span>
                          <Show when={props.favorites.has(e.path)}>
                            <span class="text-amber-400">★</span>
                          </Show>
                          <Show when={e.branch}>
                            <span class="max-w-[40%] shrink-0 truncate font-mono text-xs text-neutral-500">⎇ {e.branch}</span>
                          </Show>
                          <span class="text-neutral-600">›</span>
                        </button>
                      </li>
                    )}
                  </For>
                </ul>
              </Show>

              <Show when={cur().path}>
                {(path) => (
                  <div class="sticky bottom-[max(1rem,env(safe-area-inset-bottom))]">
                    <button
                      onClick={() => go.dir(path())}
                      class="w-full truncate rounded-xl bg-neutral-100 px-4 py-2.5 font-medium text-neutral-900 shadow-lg shadow-black/50"
                    >
                      在 {basename(path())} 开会话
                    </button>
                  </div>
                )}
              </Show>
            </div>
          )
        }}
      </Show>
    </Loading>
  )
}
