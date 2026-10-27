// 看文件：工具卡片里的路径、选目录时列出的文件，点开都到这。整个应用只挂一个（App 里），openFile(path) 打开。
// 图片、音视频、PDF 浏览器自己显示，Markdown 渲染（能切源码），其余当文本只看开头；底下分享（存到文件、AirDrop）和下载
import { Portal } from '@solidjs/web'
import { createEffect, createMemo, createSignal, Errored, For, Loading, Match, onCleanup, Show, Switch } from 'solid-js'
import type { FileEntry } from '../../../shared/protocol'
import { api, ApiError } from '../api'
import { canShareFiles, fileKind, fileUrl, looksBinary, PREVIEW_BYTES } from '../files'
import { ago, basename, bytes, errorText, rootLabel } from '../format'
import { route } from '../router'
import { Markdown } from './Markdown'

async function get(url: string, init?: RequestInit) {
  const res = await fetch(url, init)
  if (!res.ok) throw new ApiError(res.status, (await res.json().catch(() => ({}))).error ?? `HTTP ${res.status}`)
  return res
}

/** 文本文件的开头（大的只取前 PREVIEW_BYTES，最后一个字可能被截成半个）；二进制的返回 undefined */
async function readHead(f: FileEntry): Promise<string | undefined> {
  if (!f.size) return ''
  const range = f.size > PREVIEW_BYTES ? { headers: { Range: `bytes=0-${PREVIEW_BYTES - 1}` } } : undefined
  const bytes = new Uint8Array(await (await get(fileUrl(f), range)).arrayBuffer()).subarray(0, PREVIEW_BYTES)
  return looksBinary(bytes) ? undefined : new TextDecoder().decode(bytes)
}

/** 取成 File 给 navigator.share；类型用服务端给的，分享面板据此决定能存到哪（照片、文件） */
async function loadForShare(f: FileEntry): Promise<File> {
  const blob = await (await get(fileUrl(f))).blob()
  return new File([blob], f.name, { type: blob.type.split(';')[0] || 'application/octet-stream' })
}

const [current, setCurrent] = createSignal<string>()

/** 全屏看这个文件（绝对路径） */
export const openFile = (path: string) => setCurrent(path)

export function FileSheet() {
  // 换了页面（返回、点推送进来）就关掉
  createEffect(route, () => setCurrent(undefined))
  return (
    <Show when={current()} keyed>
      {(path) => <Sheet path={path} onClose={() => setCurrent(undefined)} />}
    </Show>
  )
}

const note = 'p-4 text-sm text-neutral-500'

function Sheet(props: { path: string; onClose: () => void }) {
  const stat = createMemo(() => api<FileEntry>(`/fs/stat?path=${encodeURIComponent(props.path)}`))
  const onKey = (e: KeyboardEvent) => e.key === 'Escape' && props.onClose()
  document.addEventListener('keydown', onKey)
  onCleanup(() => document.removeEventListener('keydown', onKey))
  return (
    <Portal>
      <div role="dialog" aria-modal="true" aria-label={basename(props.path)} class="fixed inset-0 z-50 flex flex-col bg-neutral-950">
        <header class="flex items-center gap-3 border-b border-neutral-800 px-3 pt-[max(0.5rem,env(safe-area-inset-top))] pb-2">
          <div class="min-w-0 flex-1">
            <p class="truncate text-sm font-medium">{basename(props.path)}</p>
            <p class="truncate text-left font-mono text-xs text-neutral-500" dir="rtl">
              {/* 太长时截掉开头，留着文件名附近 */}
              <bdi>{rootLabel(props.path)}</bdi>
            </p>
          </div>
          <button
            onClick={() => props.onClose()}
            aria-label="关闭"
            class="grid size-9 shrink-0 place-items-center rounded-full bg-neutral-800 text-xl leading-none text-white"
          >
            ×
          </button>
        </header>
        <Errored fallback={(err) => <p class="p-4 text-sm text-red-400">{errorText(err())}</p>}>
          <Loading fallback={<p class={note}>加载中…</p>}>
            <Body file={stat()} />
            <Footer file={stat()} />
          </Loading>
        </Errored>
      </div>
    </Portal>
  )
}

function Body(props: { file: FileEntry }) {
  const kind = () => fileKind(props.file.name)
  const url = () => fileUrl(props.file)
  return (
    <div class="min-h-0 flex-1 overflow-auto overscroll-contain">
      <Switch fallback={<TextView file={props.file} markdown={kind() === 'markdown'} />}>
        <Match when={kind() === 'image'}>
          <ImageView url={url()} />
        </Match>
        <Match when={kind() === 'video'}>
          <div class="flex size-full items-center justify-center">
            <video src={url()} controls playsinline class="max-h-full max-w-full" />
          </div>
        </Match>
        <Match when={kind() === 'audio'}>
          <div class="p-4">
            <audio src={url()} controls class="w-full" />
          </div>
        </Match>
        <Match when={kind() === 'pdf'}>
          <iframe src={url()} title={props.file.name} class="size-full bg-white" />
        </Match>
      </Switch>
    </div>
  )
}

/** 默认缩到屏内，点图看原尺寸（大了能滚） */
function ImageView(props: { url: string }) {
  const [full, setFull] = createSignal(false)
  return (
    <div class={full() ? 'flex min-h-full w-max min-w-full items-center justify-center p-2' : 'flex size-full items-center justify-center p-2'}>
      <img
        src={props.url}
        alt=""
        onClick={() => setFull(!full())}
        class={full() ? 'max-w-none cursor-zoom-out' : 'max-h-full max-w-full cursor-zoom-in object-contain'}
      />
    </div>
  )
}

function TextView(props: { file: FileEntry; markdown: boolean }) {
  const text = createMemo(() => readHead(props.file))
  const [source, setSource] = createSignal(false)
  return (
    <Loading fallback={<p class={note}>加载中…</p>}>
      <Show when={text() !== undefined} fallback={<p class={note}>二进制文件，不预览，可以下载</p>}>
        <Show when={text()} fallback={<p class={note}>空文件</p>}>
          {(t) => (
            <>
              <Show when={props.file.size > PREVIEW_BYTES || props.markdown}>
                <div class="flex items-center gap-2 border-b border-neutral-900 px-3 py-1.5 text-xs text-neutral-500">
                  <span class="flex-1">
                    {props.file.size > PREVIEW_BYTES ? `只显示前 ${bytes(PREVIEW_BYTES)}，完整的请下载` : ''}
                  </span>
                  <Show when={props.markdown}>
                    <button onClick={() => setSource(!source())} class="rounded px-1.5 py-0.5 active:bg-neutral-800">
                      {source() ? '看渲染' : '看源码'}
                    </button>
                  </Show>
                </div>
              </Show>
              <Show when={props.markdown && !source()} fallback={<Lines text={t()} />}>
                <Markdown text={t()} class="px-4 py-3 text-sm" />
              </Show>
            </>
          )}
        </Show>
      </Show>
    </Loading>
  )
}

/** 带行号，长行折行 */
function Lines(props: { text: string }) {
  const lines = createMemo(() => props.text.replace(/\n$/, '').split('\n'))
  return (
    <div class="py-2 font-mono text-[11px] leading-relaxed text-neutral-300">
      <For each={lines()}>
        {(line, i) => (
          <div class="flex">
            <span class="w-10 shrink-0 pr-2 text-right text-neutral-600 select-none">{i() + 1}</span>
            <span class="min-w-0 flex-1 pr-2 whitespace-pre-wrap break-all">{line}</span>
          </div>
        )}
      </For>
    </div>
  )
}

const action = 'shrink-0 rounded-lg border border-neutral-700 px-3 py-1.5 text-neutral-200 active:bg-neutral-800'

function Footer(props: { file: FileEntry }) {
  return (
    <footer class="flex items-center gap-2 border-t border-neutral-800 px-3 pt-2 pb-[max(0.5rem,env(safe-area-inset-bottom))] text-sm">
      <span class="min-w-0 flex-1 truncate text-xs text-neutral-500">
        {bytes(props.file.size)} · {ago(props.file.mtime)}修改
      </span>
      <Show when={canShareFiles(props.file)}>
        {/* 取不下来就不给分享，下载还在 */}
        <Errored fallback={null}>
          <Loading fallback={<button disabled class={`${action} opacity-50`}>分享</button>}>
            <ShareButton file={props.file} />
          </Loading>
        </Errored>
      </Show>
      <a href={fileUrl(props.file, true)} download={props.file.name} class={action}>
        下载
      </a>
    </footer>
  )
}

/**
 * 系统分享面板（存到「文件」、AirDrop、发给别的 App）。文件先取好：iOS 要在点按钮的同一下调 share，
 * 中间等了网络就不认是用户点的
 */
function ShareButton(props: { file: FileEntry }) {
  const file = createMemo(() => loadForShare(props.file))
  const share = (f: File) =>
    navigator.share({ files: [f] }).catch((e: Error) => {
      if (e.name !== 'AbortError') alert(`分享失败：${errorText(e)}`)
    })
  // 在这里读，取好之前外面的 Loading 显示灰的按钮
  return (
    <Show when={file()}>
      {(f) => (
        <button onClick={() => share(f())} class={action}>
          分享
        </button>
      )}
    </Show>
  )
}
