import {
  action,
  createMemo,
  createOptimistic,
  createSignal,
  Errored,
  For,
  isPending,
  Loading,
  onSettled,
  refresh,
  Show,
  untrack,
} from 'solid-js'
import type {
  CreateSessionBody,
  DirInfo,
  DirSession,
  DirSessions,
  EffortLevel,
  FavoriteBody,
  SessionInfo,
  SwitchableMode,
} from '../../../shared/protocol'
import { api, ApiError, cachedGet } from '../api'
import { CommandMenu, slashQuery } from '../components/CommandMenu'
import { attachments, createImages, ImageButton, ImageStrip } from '../components/Images'
import { ModelSheet } from '../components/ModelSheet'
import { loadDraft, saveDraft } from '../draft'
import { StateBadge } from '../components/StateBadge'
import { ago, basename, errorText, MODE_BORDER, MODE_LABEL, MODE_TEXT, shortPath } from '../format'
import { afterPaint } from '../frame'
import { useOverview } from '../overview'
import { go } from '../router'
import { removeSession } from '../session/store'
import { modelName } from '../status'

/** 目录页：在这个目录开新会话，或者打开它的历史会话（终端里开的也在） */
export function DirPage(props: { path: string }) {
  // 目录不存在、不在 roots 内时这里就报错，不用等到点开始
  // 换目录时整页重建（App 里 keyed），path 只取一次
  const info = cachedGet<DirInfo>(`/dir?path=${encodeURIComponent(untrack(() => props.path))}`)
  const [favorite, setFavorite] = createOptimistic(() => info().favorite)
  const draftKey = `dir:${untrack(() => props.path)}`
  const [prompt, setPromptRaw] = createSignal(loadDraft(draftKey))
  const setPrompt = (t: string) => {
    setPromptRaw(t)
    saveDraft(draftKey, t)
  }
  const slash = () => slashQuery(prompt())
  /** 模式、模型（列表项的 value）、effort：不选就不传，由 Claude Code 自己定 */
  const [mode, setMode] = createSignal<SwitchableMode>()
  const [model, setModel] = createSignal<string>()
  const [effort, setEffort] = createSignal<EffortLevel>()
  const [picking, setPicking] = createSignal(false)
  const [error, setError] = createSignal('')
  const [busy, setBusy] = createSignal(false)
  const images = createImages(setError)
  let input!: HTMLTextAreaElement

  // focus 会带出滚动，等整页画出来再做，见 afterPaint
  onSettled(() => afterPaint(() => input.focus()))

  // 先亮星再请求；失败时 action 结束，乐观值自动退回
  const toggleFavorite = action(function* () {
    const next = !favorite()
    setFavorite(next)
    setError('')
    try {
      yield api('/favorites', { path: info().path, favorite: next } satisfies FavoriteBody)
    } catch (e) {
      setError(errorText(e))
      return
    }
    // 等重取落地再结束 action，乐观值不会先退回再跳过来；缓存也随之更新
    yield refresh(info)
  })

  const start = async () => {
    setBusy(true)
    setError('')
    try {
      const body: CreateSessionBody = {
        cwd: info().path,
        prompt: prompt(),
        images: attachments(images.list()),
        permissionMode: mode(),
        model: model(),
        effort: effort(),
      }
      const s = await api<SessionInfo>('/sessions', body)
      setPrompt('')
      go.session(s.id)
    } catch (e) {
      setError(errorText(e))
      setBusy(false)
    }
  }

  /** 选了的才显示，如 Sonnet · low · 规划 */
  const choice = () => [model() && modelName(model()!), effort(), mode() && MODE_LABEL[mode()!]].filter(Boolean).join(' · ')
  const choiceColor = () => {
    const m = mode()
    return (m && MODE_TEXT[m] && `${MODE_BORDER[m]} ${MODE_TEXT[m]}`) || `border-neutral-700 ${choice() ? 'text-neutral-200' : 'text-neutral-500'}`
  }

  // 目录还没取到时画个禁用的占着位置（选图、选模型照样能用）
  const startRow = (disabled: () => boolean) => (
    <div class="flex gap-3">
      {/* 图标左边对齐输入框 */}
      <ImageButton images={images} class="-ml-2 w-10" />
      <button
        onClick={() => setPicking(true)}
        aria-label="模型和权限模式"
        class={`max-w-[55%] min-w-0 truncate rounded-full border bg-neutral-900 px-3 text-sm ${choiceColor()}`}
      >
        {choice() || '模型 · 模式'}
      </button>
      <button
        onClick={start}
        disabled={disabled()}
        class="flex-1 rounded-xl bg-neutral-100 py-2.5 font-medium text-neutral-900 disabled:opacity-40"
      >
        {busy() ? '启动中…' : '开始'}
      </button>
    </div>
  )

  return (
    <div class="mx-auto flex min-h-dvh max-w-2xl flex-col gap-4 px-4 pt-[max(1rem,env(safe-area-inset-top))] pb-[max(1.5rem,env(safe-area-inset-bottom))]">
      {/* 目录不存在、不在 roots 内（「最近」里可能有 /tmp 这类） */}
      <Errored
        fallback={(err) => (
          <>
            <DirHeader path={props.path} />
            <p class="text-sm text-red-400">{errorText(err())}</p>
          </>
        )}
      >
        <Loading fallback={<DirHeader path={props.path} />}>
          <DirHeader path={props.path} branch={info().branch} favorite={favorite()} onFavorite={toggleFavorite} />
        </Loading>
        {/* 在 Loading 外：进来就能打字 */}
        <textarea
          ref={input}
          value={prompt()}
          onInput={(e) => setPrompt(e.currentTarget.value)}
          onPaste={images.paste}
          placeholder="让 Claude 做什么？"
          rows={4}
          class="resize-none rounded-xl border border-neutral-700 bg-neutral-900 px-3 py-2.5 text-base outline-none focus:border-neutral-500"
        />
        <ImageStrip images={images} class="-mt-2" />
        {/* 用 props.path 取命令列表：目录不在 roots 内时服务端报错，列表里显示 */}
        <Show when={slash() !== undefined}>
          <CommandMenu
            cwd={props.path}
            query={slash() ?? ''}
            onPick={(name) => {
              setPrompt(`/${name} `)
              input.focus()
            }}
          />
        </Show>
        <Show when={error()}>
          <p class="text-sm text-red-400">{error()}</p>
        </Show>
        <Loading fallback={startRow(() => true)}>
          {/* isPending 顺带读了 info：没取到时 Loading 等它 */}
          {startRow(() => isPending(() => info()) || (!prompt().trim() && !images.list().length) || images.pending() || busy())}
          <History path={props.path} branch={info().branch} />
        </Loading>
      </Errored>
      <Show when={picking()}>
        <ModelSheet
          cwd={props.path}
          draft
          model={model()}
          effort={effort()}
          mode={mode()}
          onModel={(v) => setModel(v)}
          onEffort={(v) => setEffort(v)}
          onMode={(v) => setMode(v)}
          onClose={() => setPicking(false)}
        />
      </Show>
    </div>
  )
}

/** 目录名、路径、分支、收藏星标。没 onFavorite（还没取到、打不开）时星标禁用，分支占位 */
function DirHeader(props: { path: string; branch?: string; favorite?: boolean; onFavorite?: () => void }) {
  return (
    <header class="flex items-center gap-3">
      <button onClick={go.home} class="-ml-1 px-1 text-2xl leading-none text-neutral-400">
        ‹
      </button>
      <div class="min-w-0 flex-1">
        <h1 class="truncate font-semibold">{basename(props.path)}</h1>
        <p class="flex min-h-4 items-center gap-2 truncate text-xs text-neutral-500">
          <span class="truncate">{shortPath(props.path, 4)}</span>
          <span class={`shrink-0 truncate font-mono ${props.branch ? '' : 'invisible'}`} aria-hidden={props.branch ? undefined : 'true'}>
            ⎇ {props.branch ?? '···'}
          </span>
        </p>
      </div>
      <button
        onClick={() => props.onFavorite?.()}
        disabled={!props.onFavorite}
        aria-label={props.favorite ? '取消收藏' : '收藏'}
        aria-pressed={props.favorite ? 'true' : 'false'}
        class={`-mr-1 h-8 w-8 shrink-0 text-2xl leading-none disabled:opacity-30 ${props.favorite ? 'text-amber-400' : 'text-neutral-500'}`}
      >
        {props.favorite ? '★' : '☆'}
      </button>
    </header>
  )
}

/** 各目录历史会话的第一页：再进来先显示上次的，同时重新取 */
const firstPages = new Map<string, DirSessions>()

/** 该目录的历史会话，一页 30 个。正在跑的（托管的、终端里的）从概览流里取状态 */
function History(props: { path: string; branch?: string }) {
  const all = useOverview()
  const byId = createMemo(() => new Map(all.map((s) => [s.id, s])))
  const cached = firstPages.get(untrack(() => props.path))
  const [list, setList] = createSignal<DirSession[]>(cached?.sessions ?? [])
  const [more, setMore] = createSignal(cached?.more ?? false)
  /** fresh：重新取第一页（替换先显示着的缓存）；more：翻下一页 */
  const [loading, setLoading] = createSignal<false | 'fresh' | 'more'>('fresh')
  const [error, setError] = createSignal('')
  /** 编辑中：每条后面出「删除」 */
  const [editing, setEditing] = createSignal(false)
  /** 正在删的那条，删完之前别的删不了 */
  const [removing, setRemoving] = createSignal<string>()
  /** 删掉了的：删之前发出去的取列表请求，回来时还带着它 */
  const removed = new Set<string>()
  const keep = (l: DirSession[]) => l.filter((d) => !removed.has(d.id))

  const load = async (kind: 'fresh' | 'more') => {
    setLoading(kind)
    setError('')
    try {
      const offset = kind === 'fresh' ? 0 : list().length
      const page = await api<DirSessions>(`/dir/sessions?path=${encodeURIComponent(props.path)}&offset=${offset}`)
      if (kind === 'fresh') {
        firstPages.set(props.path, page)
        setList(keep(page.sessions))
      } else {
        // 翻页期间有新会话时 offset 会错开，按 id 去重
        const seen = new Set(list().map((d) => d.id))
        setList([...list(), ...keep(page.sessions).filter((d) => !seen.has(d.id))])
      }
      setMore(page.more)
    } catch (e) {
      setError(errorText(e))
    } finally {
      setLoading(false)
    }
  }
  // load 一开始就写信号，组件体里不能写，挂上之后再取
  onSettled(() => void load('fresh'))

  // 正在跑的服务端会先中断它
  const remove = async (d: DirSession) => {
    const busy = (byId().get(d.id)?.state ?? 'idle') !== 'idle'
    if (!confirm(`删除「${d.title}」？对话记录一起删掉，找不回来。${busy ? '\nClaude 正在运行，会先中断。' : ''}`)) return
    setRemoving(d.id)
    setError('')
    try {
      await removeSession(d.id)
    } catch (e) {
      // 别处已经删了的（404）照样从列表里拿掉
      if (!(e instanceof ApiError) || e.status !== 404) {
        setError(errorText(e))
        return
      }
    } finally {
      setRemoving(undefined)
    }
    removed.add(d.id)
    setList(keep(list()))
    const first = firstPages.get(props.path)
    if (first) firstPages.set(props.path, { ...first, sessions: keep(first.sessions) })
    if (!list().length) setEditing(false)
  }

  return (
    <section class="mt-2">
      <div class="mb-2 flex items-center justify-between">
        <h2 class="text-xs font-medium tracking-wide text-neutral-500">历史会话</h2>
        <Show when={list().length}>
          <button onClick={() => setEditing(!editing())} class="-my-2 -mr-2 px-2 py-2 text-xs text-neutral-400">
            {editing() ? '完成' : '编辑'}
          </button>
        </Show>
      </div>
      <Show when={list().length}>
        <ul class="divide-y divide-neutral-800 rounded-xl border border-neutral-800">
          <For each={list()}>
            {(d) => {
              const s = (): SessionInfo | undefined => byId().get(d.id)
              const branch = () => (d.branch && d.branch !== 'HEAD' && d.branch !== props.branch ? d.branch : '')
              return (
                <li class="flex">
                  <button onClick={() => go.session(d.id)} class="flex min-w-0 flex-1 flex-col gap-1 px-3 py-2.5 text-left">
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
                  {/* 终端里开着的归终端管，不能删 */}
                  <Show when={editing() && !s()?.terminal}>
                    <button
                      onClick={() => void remove(d)}
                      disabled={!!removing()}
                      class="shrink-0 px-4 text-sm text-red-400 active:bg-neutral-800 disabled:opacity-40"
                    >
                      {removing() === d.id ? '删除中…' : '删除'}
                    </button>
                  </Show>
                </li>
              )
            }}
          </For>
        </ul>
      </Show>
      <Show when={error()}>
        <p class="text-sm text-red-400">{error()}</p>
      </Show>
      {/* 有缓存的列表先显示着，后台刷新时不出「加载中」 */}
      <Show when={loading() === 'more' || (loading() && !list().length)}>
        <p class="py-2 text-sm text-neutral-500">加载中…</p>
      </Show>
      <Show when={!loading() && !error() && !list().length}>
        <p class="text-sm text-neutral-500">这个目录还没有会话</p>
      </Show>
      <Show when={more() && !loading()}>
        <button onClick={() => void load('more')} class="mt-2 block w-full py-2 text-center text-sm text-neutral-400">
          更多
        </button>
      </Show>
    </section>
  )
}
