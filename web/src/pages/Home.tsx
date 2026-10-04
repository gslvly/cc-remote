import { createMemo, createSignal, type Element, Errored, For, Loading, Match, Show, Switch } from 'solid-js'
import type { DirEntry, RecentDir } from '../../../shared/protocol'
import { cachedGet } from '../api'
import { DirBrowser } from '../components/DirBrowser'
import { PushToggle } from '../components/PushToggle'
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
  const recent = cachedGet<RecentDir[]>('/recent')
  const favs = cachedGet<DirEntry[]>('/favorites')
  const [tab, setTab] = createSignal(sessionStorage.getItem(TAB_KEY) as Tab | null)

  const favSet = createMemo(() => new Set(favs().map((f) => f.path)))
  // 没选过 tab 时要等收藏取到
  const current = (): Tab => tab() ?? (favs().length ? 'fav' : 'recent')
  const pick = (t: Tab) => {
    sessionStorage.setItem(TAB_KEY, t)
    setTab(t)
  }

  // 加载中、出错时也画标签条，免得取到后往下跳
  const tabs = (cur: () => Tab | null) => (
    <div role="tablist" class="mb-3 flex gap-1 rounded-lg bg-neutral-900 p-1 text-sm">
      <For each={TABS}>
        {([t, label]) => (
          <button
            role="tab"
            aria-selected={cur() === t ? 'true' : 'false'}
            onClick={() => pick(t)}
            class={`flex-1 rounded-md py-1.5 ${cur() === t ? 'bg-neutral-700 font-medium text-neutral-100' : 'text-neutral-400'}`}
          >
            {label}
          </button>
        )}
      </For>
    </div>
  )

  return (
    <div class="mx-auto max-w-2xl px-4 pt-[max(1rem,env(safe-area-inset-top))] pb-[max(2rem,env(safe-area-inset-bottom))]">
      <div class="mb-4 flex items-center justify-between gap-3">
        <div class="flex items-center gap-2">
          <h1 class="text-lg font-semibold">cc-remote</h1>
          <PushToggle />
        </div>
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
        <Errored
          fallback={(err) => (
            <>
              {tabs(tab)}
              <p class="text-sm text-red-400">{errorText(err())}</p>
            </>
          )}
        >
          <Loading
            fallback={
              <>
                {tabs(tab)}
                <p class="text-sm text-neutral-500">加载中…</p>
              </>
            }
          >
            {tabs(current)}
            <Switch>
              <Match when={current() === 'recent'}>
                <Listing items={recent()} empty="还没有用过 Claude Code 的目录">
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
                <Listing items={favs()} empty="还没有收藏。进入目录后点右上角的 ☆ 收藏">
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
          </Loading>
        </Errored>
      </section>
    </div>
  )
}

/**
 * 列表型的 GET：加载中 / 出错 / 空 / 列表。
 * 收值不收 accessor：props 是惰性的，props.items 在这里读，挂起和出错就落在这里的边界上
 */
function Listing<T>(props: { items: T[]; empty: string; children: (item: T) => Element }) {
  return (
    <Errored fallback={(err) => <p class="text-sm text-red-400">{errorText(err())}</p>}>
      <Loading fallback={<p class="text-sm text-neutral-500">加载中…</p>}>
        <Show when={props.items.length} fallback={<p class="text-sm text-neutral-500">{props.empty}</p>}>
          <ul class="divide-y divide-neutral-800 rounded-xl border border-neutral-800">
            <For each={props.items}>{(item) => <li>{props.children(item)}</li>}</For>
          </ul>
        </Show>
      </Loading>
    </Errored>
  )
}
