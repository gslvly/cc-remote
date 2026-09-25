import { createMemo, createResource, createSignal, For, type JSX, Match, type Resource, Show, Switch } from 'solid-js'
import type { DirEntry, RecentDir } from '../../../shared/protocol'
import { api } from '../api'
import { DirBrowser } from '../components/DirBrowser'
import { StateBadge } from '../components/StateBadge'
import { QuotaText } from '../components/StatusLine'
import { ago, basename, errorText, shortPath } from '../format'
import { useOverview, useQuota } from '../overview'
import { go } from '../router'

type Tab = 'recent' | 'fav' | 'browse'
const TABS: [Tab, string][] = [
  ['recent', '最近'],
  ['fav', '收藏'],
  ['browse', '浏览'],
]
// 当前 tab 只在这次打开 App 期间记住（从目录页返回时还在原 tab）；重新打开时有收藏就先看收藏
const TAB_KEY = 'ccr-home-tab'

export function Home() {
  const live = useOverview()
  const quota = useQuota()
  const [recent] = createResource(() => api<RecentDir[]>('/recent'))
  const [favs] = createResource(() => api<DirEntry[]>('/favorites'))
  const [tab, setTab] = createSignal(sessionStorage.getItem(TAB_KEY) as Tab | null)

  const favSet = createMemo(() => new Set(favs.state === 'ready' ? favs().map((f) => f.path) : []))
  const current = (): Tab | null => {
    const t = tab()
    if (t) return t
    if (favs.state === 'ready') return favs().length ? 'fav' : 'recent'
    return favs.state === 'errored' ? 'recent' : null
  }
  const pick = (t: Tab) => {
    sessionStorage.setItem(TAB_KEY, t)
    setTab(t)
  }

  return (
    <div class="mx-auto max-w-2xl px-4 pt-[max(1rem,env(safe-area-inset-top))] pb-[max(2rem,env(safe-area-inset-bottom))]">
      <div class="mb-4 flex items-center justify-between gap-3">
        <h1 class="text-lg font-semibold">cc-remote</h1>
        <div aria-label="额度" class="flex gap-x-4 text-xs tabular-nums">
          <QuotaText quota={quota()} />
        </div>
      </div>

      <Show when={live.length}>
        <section class="mb-6">
          <h2 class="mb-2 text-xs font-medium tracking-wide text-neutral-500">会话</h2>
          <ul class="divide-y divide-neutral-800 rounded-xl border border-neutral-800">
            <For each={live}>
              {(s) => (
                <li>
                  <button onClick={() => go.session(s.id)} class="flex w-full flex-col gap-1 px-3 py-2.5 text-left">
                    <div class="flex items-center justify-between gap-2">
                      <span class="truncate">{s.title}</span>
                      <StateBadge state={s.state} terminal={s.terminal} />
                    </div>
                    <span class="text-xs text-neutral-500">
                      {basename(s.cwd)} · {ago(s.lastActivity)}
                    </span>
                  </button>
                </li>
              )}
            </For>
          </ul>
        </section>
      </Show>

      <section>
        <div role="tablist" class="mb-3 flex gap-1 rounded-lg bg-neutral-900 p-1 text-sm">
          <For each={TABS}>
            {([t, label]) => (
              <button
                role="tab"
                aria-selected={current() === t}
                onClick={() => pick(t)}
                class={`flex-1 rounded-md py-1.5 ${current() === t ? 'bg-neutral-700 font-medium text-neutral-100' : 'text-neutral-400'}`}
              >
                {label}
              </button>
            )}
          </For>
        </div>

        <Switch>
          <Match when={current() === 'recent'}>
            <Listing of={recent} empty="还没有用过 Claude Code 的目录">
              {(d) => (
                <button onClick={() => go.dir(d.cwd)} class="flex w-full flex-col gap-0.5 px-3 py-2.5 text-left">
                  <div class="flex items-baseline justify-between gap-2">
                    <span class="truncate font-medium">
                      {basename(d.cwd)}
                      <Show when={favSet().has(d.cwd)}>
                        <span class="ml-1.5 text-amber-400">★</span>
                      </Show>
                    </span>
                    <span class="shrink-0 text-xs text-neutral-500">{ago(d.lastModified)}</span>
                  </div>
                  <span class="truncate text-xs text-neutral-500">{shortPath(d.cwd, 4)}</span>
                  <span class="truncate text-xs text-neutral-400">{d.lastTitle}</span>
                </button>
              )}
            </Listing>
          </Match>
          <Match when={current() === 'fav'}>
            <Listing of={favs} empty="还没有收藏。进入目录后点右上角的 ☆ 收藏">
              {(d) => (
                <button onClick={() => go.dir(d.path)} class="flex w-full flex-col gap-0.5 px-3 py-2.5 text-left">
                  <div class="flex items-baseline justify-between gap-2">
                    <span class="truncate font-medium">{d.name}</span>
                    <Show when={d.branch}>
                      <span class="max-w-[40%] shrink-0 truncate font-mono text-xs text-neutral-500">⎇ {d.branch}</span>
                    </Show>
                  </div>
                  <span class="truncate text-xs text-neutral-500">{shortPath(d.path, 4)}</span>
                </button>
              )}
            </Listing>
          </Match>
          <Match when={current() === 'browse'}>
            <DirBrowser favorites={favSet()} />
          </Match>
        </Switch>
      </section>
    </div>
  )
}

/** 列表型 resource：加载中 / 出错 / 空 / 列表 */
function Listing<T>(props: { of: Resource<T[]>; empty: string; children: (item: T) => JSX.Element }) {
  return (
    <Switch fallback={<p class="text-sm text-neutral-500">加载中…</p>}>
      <Match when={props.of.error}>
        <p class="text-sm text-red-400">{errorText(props.of.error)}</p>
      </Match>
      <Match when={props.of()?.length === 0}>
        <p class="text-sm text-neutral-500">{props.empty}</p>
      </Match>
      <Match when={props.of()}>
        {(items) => (
          <ul class="divide-y divide-neutral-800 rounded-xl border border-neutral-800">
            <For each={items()}>{(item) => <li>{props.children(item)}</li>}</For>
          </ul>
        )}
      </Match>
    </Switch>
  )
}
