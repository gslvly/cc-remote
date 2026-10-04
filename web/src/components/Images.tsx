import { createSignal, For, Show } from 'solid-js'
import type { ImageAttachment } from '../../../shared/protocol'
import { errorText } from '../format'
import { type PickedImage, prepareImage } from '../image'

/** 待发的一张图片：还在压缩时 img 为空 */
type Slot = { img?: PickedImage }

/**
 * 随消息发的图片（输入框、目录页共用）。不存草稿（太大）。
 * 按添加的顺序占好位，压缩完填进去（Claude 说「第一张」要对得上）
 */
export function createImages(onError: (message: string) => void) {
  const [list, setList] = createSignal<Slot[]>([])

  const add = (files: File[]) => {
    onError('')
    for (const f of files) {
      const slot: Slot = {}
      setList((l) => [...l, slot])
      prepareImage(f).then(
        (img) => setList((l) => l.map((s) => (s === slot ? { img } : s))),
        (e) => {
          setList((l) => l.filter((s) => s !== slot))
          onError(errorText(e))
        },
      )
    }
  }

  return {
    list,
    /** 还有没压缩完的 */
    pending: () => list().some((s) => !s.img),
    add,
    /** 去掉这些（发出去的）；发送期间又加的留着 */
    remove: (gone: Slot[]) => setList((l) => l.filter((s) => !gone.includes(s))),
    /** 粘贴截图（电脑上 Ctrl+V）；剪贴板里同时有文字的（表格之类）照常贴文字 */
    paste: (e: ClipboardEvent) => {
      const files = [...(e.clipboardData?.files ?? [])].filter((f) => f.type.startsWith('image/'))
      if (!files.length || e.clipboardData?.getData('text/plain')) return
      e.preventDefault()
      add(files)
    },
  }
}

export type Images = ReturnType<typeof createImages>

/** 压缩完的才发（调用方先等 pending 结束） */
export const attachments = (slots: Slot[]): ImageAttachment[] =>
  slots.map((s) => ({ mediaType: s.img!.mediaType, data: s.img!.data }))

/** 选图按钮，带一个看不见的文件输入框 */
export function ImageButton(props: { images: Images; class?: string }) {
  let picker!: HTMLInputElement
  return (
    <>
      <input
        ref={picker}
        type="file"
        accept="image/*"
        multiple
        class="hidden"
        onChange={(e) => {
          const files = [...(e.currentTarget.files ?? [])]
          // 清掉，同一张还能再选
          e.currentTarget.value = ''
          if (files.length) props.images.add(files)
        }}
      />
      <button
        onClick={() => picker.click()}
        aria-label="添加图片"
        class={`grid shrink-0 place-items-center text-neutral-400 ${props.class ?? ''}`}
      >
        <svg viewBox="0 0 24 24" class="size-6" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">
          <rect x="3" y="4" width="18" height="16" rx="2.5" />
          <circle cx="8.5" cy="9.5" r="1.5" />
          <path d="m21 16-5-5-9 9" />
        </svg>
      </button>
    </>
  )
}

/** 缩略图一排，右上角 × 去掉。没图时不占地方 */
export function ImageStrip(props: { images: Images; class?: string }) {
  return (
    <Show when={props.images.list().length}>
      {/* 横向滚动会把竖向也裁掉，pt-1 给露出去的 × 留地方 */}
      <div class={`flex gap-2 overflow-x-auto pt-1 ${props.class ?? ''}`}>
        <For each={props.images.list()}>
          {(slot) => (
            <Show when={slot.img} fallback={<div class="size-14 shrink-0 animate-pulse rounded-lg bg-neutral-800" />}>
              {(img) => (
                <div class="relative size-14 shrink-0">
                  <img src={img().url} alt="" class="size-14 rounded-lg object-cover" />
                  <button
                    onClick={() => props.images.remove([slot])}
                    aria-label="去掉这张图片"
                    class="absolute -top-1 -right-1 grid size-5 place-items-center rounded-full bg-neutral-600 text-xs leading-none text-white"
                  >
                    ×
                  </button>
                </div>
              )}
            </Show>
          )}
        </For>
      </div>
    </Show>
  )
}
