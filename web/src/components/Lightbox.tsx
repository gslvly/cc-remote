// 看图：消息里的图是缩略图，点开全屏看
import { Portal } from '@solidjs/web'
import { createContext, createSignal, For, onCleanup, Show, useContext } from 'solid-js'

/** 当前会话取图的地址前缀（/api/sessions/<id>/images），消息列表外面给 */
export const ImageBase = createContext('')

/** id 那条消息（或那次工具调用）里的 count 张图，图按需从服务端取 */
export function MessageImages(props: { id: string; count: number; class?: string }) {
  const base = useContext(ImageBase)
  const urls = () => Array.from({ length: props.count }, (_, i) => `${base}/${props.id}/${i}`)
  return (
    <div class={`flex flex-wrap gap-2 ${props.class ?? ''}`}>
      <For each={urls()}>{(url) => <Thumb url={url} />}</For>
    </div>
  )
}

/** 一张缩略图，点开看大图。在会冒泡的地方（能点开回退的气泡）也只管看图 */
export function Thumb(props: { url: string; class?: string }) {
  const [open, setOpen] = createSignal(false)
  const [failed, setFailed] = createSignal(false)
  return (
    <>
      <button
        onClick={(e) => {
          e.stopPropagation()
          if (!failed()) setOpen(true)
        }}
        aria-label="看大图"
        class={`shrink-0 overflow-hidden rounded-lg bg-neutral-900 ${props.class ?? 'size-16'}`}
      >
        <Show when={!failed()} fallback={<span class="text-[10px] text-neutral-500">图片取不到</span>}>
          <img src={props.url} alt="" loading="lazy" onError={() => setFailed(true)} class="size-full object-cover" />
        </Show>
      </button>
      <Show when={open()}>
        <Lightbox url={props.url} onClose={() => setOpen(false)} />
      </Show>
    </>
  )
}

/** 全屏看一张：默认缩到屏内，点图看原尺寸（大了能滚），点空白、× 或 Esc 关 */
function Lightbox(props: { url: string; onClose: () => void }) {
  const [full, setFull] = createSignal(false)
  const onKey = (e: KeyboardEvent) => e.key === 'Escape' && props.onClose()
  document.addEventListener('keydown', onKey)
  onCleanup(() => document.removeEventListener('keydown', onKey))
  return (
    <Portal>
      {/* Solid 的事件委托会顺着 Portal 冒到缩略图上（又打开一次），在这里拦住 */}
      <div
        onClick={(e) => {
          e.stopPropagation()
          props.onClose()
        }}
        class="fixed inset-0 z-50 overflow-auto overscroll-contain bg-black/95">
        <div class="grid min-h-full w-max min-w-full place-items-center p-2">
          <img
            src={props.url}
            alt=""
            onClick={(e) => {
              e.stopPropagation()
              setFull(!full())
            }}
            class={full() ? 'max-w-none cursor-zoom-out' : 'max-h-[calc(100dvh-1rem)] max-w-[calc(100vw-1rem)] cursor-zoom-in object-contain'}
          />
        </div>
        <button
          aria-label="关闭大图"
          class="fixed top-[max(0.5rem,env(safe-area-inset-top))] right-3 grid size-9 place-items-center rounded-full bg-neutral-800/80 text-xl leading-none text-white"
        >
          ×
        </button>
      </div>
    </Portal>
  )
}
