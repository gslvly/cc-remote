import { createMemo, createResource, createSignal, For, onMount, Show } from 'solid-js'
import type {
  CreateSessionBody,
  DirInfo,
  DirSession,
  DirSessions,
  FavoriteBody,
  SessionInfo,
  SwitchableMode,
} from '../../../shared/protocol'
import { api } from '../api'
import { ModeSelect } from '../components/ModeSelect'
import { StateBadge } from '../components/StateBadge'
import { ago, basename, errorText, shortPath } from '../format'
import { useOverview } from '../overview'
import { go } from '../router'

/** 目录页：在这个目录开新会话，或者打开它的历史会话（终端里开的也在） */
export function DirPage(props: { path: string }) {
  // 目录不存在、不在 roots 内时这里就报错，不用等到点开始
  const [info, { mutate }] = createResource(() => api<DirInfo>(`/dir?path=${encodeURIComponent(props.path)}`))
  const dir = () => (info.error ? undefined : info())
  const [prompt, setPrompt] = createSignal('')
  /** 不选就不传，由 Claude Code 自己定 */
  const [mode, setMode] = createSignal<SwitchableMode>()
  const [error, setError] = createSignal('')
  const [busy, setBusy] = createSignal(false)
  let input!: HTMLTextAreaElement

  onMount(() => input.focus())

  const toggleFavorite = async () => {
    const d = dir()
    if (!d) return
    const body: FavoriteBody = { path: d.path, favorite: !d.favorite }
    mutate({ ...d, favorite: body.favorite })
    try {
      await api('/favorites', body)
    } catch (e) {
      mutate((i) => i && { ...i, favorite: !body.favorite })
      setError(errorText(e))
    }
  }

  const start = async () => {
    const d = dir()
    if (!d) return
    setBusy(true)
    setError('')
    try {
      const body: CreateSessionBody = { cwd: d.path, prompt: prompt(), permissionMode: mode() }
      const s = await api<SessionInfo>('/sessions', body)
      go.session(s.id)
    } catch (e) {
      setError(errorText(e))
      setBusy(false)
    }
  }

  const shownError = () => error() || (info.error ? errorText(info.error) : '')

  return (
    <div class="mx-auto flex min-h-dvh max-w-2xl flex-col gap-4 px-4 pt-[max(1rem,env(safe-area-inset-top))] pb-[max(1.5rem,env(safe-area-inset-bottom))]">
      <header class="flex items-center gap-3">
        <button onClick={go.home} class="-ml-1 px-1 text-2xl leading-none text-neutral-400">
          ‹
        </button>
        <div class="min-w-0 flex-1">
          <h1 class="truncate font-semibold">{basename(props.path)}</h1>
          <p class="flex min-h-4 items-center gap-2 truncate text-xs text-neutral-500">
            <span class="truncate">{shortPath(props.path, 4)}</span>
            <span class={`shrink-0 truncate font-mono ${dir()?.branch ? '' : 'invisible'}`} aria-hidden={!dir()?.branch}>
              ⎇ {dir()?.branch ?? '···'}
            </span>
          </p>
        </div>
        <button
          onClick={toggleFavorite}
          disabled={!dir()}
          aria-label={dir()?.favorite ? '取消收藏' : '收藏'}
          aria-pressed={dir()?.favorite ?? false}
          class={`-mr-1 h-8 w-8 shrink-0 text-2xl leading-none disabled:opacity-30 ${dir()?.favorite ? 'text-amber-400' : 'text-neutral-500'}`}
        >
          {dir()?.favorite ? '★' : '☆'}
        </button>
      </header>
      <textarea
        ref={input}
        value={prompt()}
        onInput={(e) => setPrompt(e.currentTarget.value)}
        placeholder="让 Claude 做什么？"
        rows={4}
        class="resize-none rounded-xl border border-neutral-700 bg-neutral-900 px-3 py-2.5 text-base outline-none focus:border-neutral-500"
      />
      <Show when={shownError()}>
        <p class="text-sm text-red-400">{shownError()}</p>
      </Show>
      <div class="flex gap-3">
        <ModeSelect value={mode()} unset="模式：本机默认" unsetSelectable onChange={setMode} class="shrink-0" />
        <button
          onClick={start}
          disabled={!dir() || !prompt().trim() || busy()}
          class="flex-1 rounded-xl bg-neutral-100 py-2.5 font-medium text-neutral-900 disabled:opacity-40"
        >
          {busy() ? '启动中…' : '开始'}
        </button>
      </div>
      <History path={props.path} branch={dir()?.branch} />
    </div>
  )
}

/** 该目录的历史会话，一页 30 个。正在跑的（托管的、终端里的）从概览流里取状态 */
function History(props: { path: string; branch?: string }) {
  const all = useOverview()
  const byId = createMemo(() => new Map(all.map((s) => [s.id, s])))
  const [list, setList] = createSignal<DirSession[]>([])
  const [more, setMore] = createSignal(false)
  const [loading, setLoading] = createSignal(false)
  const [error, setError] = createSignal('')

  const load = async () => {
    setLoading(true)
    setError('')
    try {
      const page = await api<DirSessions>(`/dir/sessions?path=${encodeURIComponent(props.path)}&offset=${list().length}`)
      // 翻页期间有新会话时 offset 会错开，按 id 去重
      const seen = new Set(list().map((d) => d.id))
      setList([...list(), ...page.sessions.filter((d) => !seen.has(d.id))])
      setMore(page.more)
    } catch (e) {
      setError(errorText(e))
    } finally {
      setLoading(false)
    }
  }
  void load()

  return (
    <section class="mt-2">
      <h2 class="mb-2 text-xs font-medium tracking-wide text-neutral-500">历史会话</h2>
      <Show when={list().length}>
        <ul class="divide-y divide-neutral-800 rounded-xl border border-neutral-800">
          <For each={list()}>
            {(d) => {
              const s = (): SessionInfo | undefined => byId().get(d.id)
              const branch = () => (d.branch && d.branch !== 'HEAD' && d.branch !== props.branch ? d.branch : '')
              return (
                <li>
                  <button onClick={() => go.session(d.id)} class="flex w-full flex-col gap-1 px-3 py-2.5 text-left">
                    <div class="flex items-baseline justify-between gap-2">
                      <span class="truncate">{d.title}</span>
                      <span class="shrink-0 text-xs text-neutral-500">{ago(d.lastModified)}</span>
                    </div>
                    <Show when={s() || branch()}>
                      <div class="flex items-center gap-3 text-xs text-neutral-500">
                        <Show when={s()}>{(s) => <StateBadge state={s().state} terminal={s().terminal} />}</Show>
                        <Show when={branch()}>
                          <span class="truncate font-mono">⎇ {branch()}</span>
                        </Show>
                      </div>
                    </Show>
                  </button>
                </li>
              )
            }}
          </For>
        </ul>
      </Show>
      <Show when={error()}>
        <p class="text-sm text-red-400">{error()}</p>
      </Show>
      <Show when={loading()}>
        <p class="py-2 text-sm text-neutral-500">加载中…</p>
      </Show>
      <Show when={!loading() && !error() && !list().length}>
        <p class="text-sm text-neutral-500">这个目录还没有会话</p>
      </Show>
      <Show when={more() && !loading()}>
        <button onClick={() => void load()} class="mt-2 block w-full py-2 text-center text-sm text-neutral-400">
          更多
        </button>
      </Show>
    </section>
  )
}
