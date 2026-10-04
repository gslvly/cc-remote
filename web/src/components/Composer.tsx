import { createEffect, createSignal, Show, untrack } from 'solid-js'
import type { ImageAttachment, PermissionMode, SessionState } from '../../../shared/protocol'
import { loadDraft, saveDraft } from '../draft'
import { errorText, MODE_BORDER } from '../format'
import { CommandMenu, slashQuery } from './CommandMenu'
import { attachments, createImages, ImageButton, ImageStrip } from './Images'

export function Composer(props: {
  state: SessionState
  /** 只用来给输入框描边（非默认模式带颜色）；切模式在页头 */
  mode?: PermissionMode
  /** 只打开看、还没续接的历史会话：发消息就续接，进标签条 */
  history?: boolean
  /** 会话的目录：打 / 时按它取命令列表（还不知道就不弹） */
  cwd?: string
  /** 草稿按它存（会话 id），只取一次 */
  draftKey: string
  /** 换成这段文字（回退后放回的原文）；每次给新对象，同样的文字也会再填一次 */
  fill?: { text: string }
  onSend: (text: string, images: ImageAttachment[]) => Promise<unknown>
  /** ! 开头的：在会话目录里跑这条命令（终端里的 shell 模式） */
  onBash: (command: string) => Promise<unknown>
  onInterrupt: () => Promise<unknown>
}) {
  const draftKey = untrack(() => props.draftKey)
  const [text, setTextRaw] = createSignal(loadDraft(draftKey))
  const setText = (t: string) => {
    setTextRaw(t)
    saveDraft(draftKey, t)
  }
  const [busy, setBusy] = createSignal(false)
  const [error, setError] = createSignal('')
  const images = createImages(setError)
  let input: HTMLTextAreaElement | undefined
  /** 量高度用的看不见的同款输入框 */
  let measure: HTMLTextAreaElement | undefined

  const busyState = () => props.state === 'starting' || props.state === 'running' || props.state === 'requires_action'
  /** ! 开头就是命令模式，返回要跑的命令 */
  const command = () => (text().startsWith('!') ? text().slice(1).trim() : undefined)
  const empty = () => command() === '' || (!text().trim() && !images.list().length)
  const showStop = () => busyState() && empty()

  createEffect(
    () => props.fill,
    (f) => {
      if (f) setText(f.text)
    },
  )

  // 输入框随内容长高，最多 160px。在一个看不见的同款输入框里量：要是在输入框本身上先设 auto 再量，
  // 中间会按一行高排一次版，消息区跟着变高、scrollTop 被收小，输入框长回来后底部消息就被盖住一截
  createEffect(text, (t) => {
    if (!input || !measure) return
    measure.style.width = `${input.offsetWidth}px`
    measure.value = t
    input.style.height = `${Math.min(measure.scrollHeight, 160)}px`
  })

  const run = async (fn: () => Promise<unknown>, done?: () => void) => {
    setBusy(true)
    setError('')
    try {
      await fn()
      done?.()
    } catch (e) {
      setError(errorText(e))
    } finally {
      setBusy(false)
    }
  }

  const submit = () => {
    if (showStop()) return run(props.onInterrupt)
    if (empty() || images.pending()) return
    const cmd = command()
    if (cmd !== undefined) {
      if (images.list().length) return setError('命令不能带图片')
      return run(
        () => props.onBash(cmd),
        () => setText(''),
      )
    }
    const t = text()
    const sent = images.list()
    return run(
      () => props.onSend(t, attachments(sent)),
      () => {
        setText('')
        images.remove(sent)
      },
    )
  }

  // 选了命令：填进输入框，后面留个空格接着写参数（列表随之收起）
  const pick = (name: string) => {
    setText(`/${name} `)
    input?.focus()
  }
  const slash = () => slashQuery(text())

  return (
    <div class="border-t border-neutral-800 bg-neutral-950 px-3 pt-2 pb-[max(0.5rem,var(--safe-bottom,env(safe-area-inset-bottom)))]">
      <Show when={slash() !== undefined && props.cwd}>
        {(cwd) => <CommandMenu cwd={cwd()} query={slash() ?? ''} onPick={pick} />}
      </Show>
      <Show when={command() !== undefined}>
        <p class="px-1 pb-1 text-xs text-pink-400">命令模式：在会话目录里跑，输出也给 Claude 看</p>
      </Show>
      <Show when={error()}>
        <p class="px-1 pb-1 text-xs text-red-400">{error()}</p>
      </Show>
      <ImageStrip images={images} class="pb-2" />
      <div class="flex items-end gap-2">
        <ImageButton images={images} class="h-10 w-8" />
        <textarea
          ref={input}
          rows={1}
          value={text()}
          onInput={(e) => setText(e.currentTarget.value)}
          onPaste={images.paste}
          // Enter 发送，Shift/Option+Enter 换行；输入法选词时的 Enter 不算
          onKeyDown={(e) => {
            if (e.key !== 'Enter' || e.shiftKey || e.isComposing || e.keyCode === 229) return
            e.preventDefault()
            if (e.altKey) {
              // Option+Enter 浏览器不一定插换行，手动插
              const el = e.currentTarget
              el.setRangeText('\n', el.selectionStart, el.selectionEnd, 'end')
              setText(el.value)
            } else if (!busy()) void submit()
          }}
          enterkeyhint="send"
          placeholder={busyState() ? '排队发给 Claude…' : props.history ? '发消息即续接…' : '继续对话…'}
          class={`min-h-10 flex-1 resize-none rounded-2xl border bg-neutral-900 px-3.5 py-2 text-base leading-6 outline-none ${
            (command() !== undefined && 'border-pink-700') ||
            (props.mode && MODE_BORDER[props.mode]) ||
            'border-neutral-700 focus:border-neutral-500'
          }`}
        />
        {/* 排版要和上面的输入框一致（边框、内边距、字号、行高） */}
        <textarea
          ref={measure}
          rows={1}
          aria-hidden="true"
          tabindex={-1}
          class="pointer-events-none invisible absolute h-0 resize-none overflow-hidden border px-3.5 py-2 text-base leading-6"
        />
        <button
          onClick={() => void submit()}
          disabled={busy() || (!showStop() && (empty() || images.pending()))}
          aria-label={showStop() ? '中断' : '发送'}
          class={`grid size-10 shrink-0 place-items-center rounded-full text-lg disabled:opacity-30 ${
            showStop() ? 'bg-red-500/90 text-white' : 'bg-neutral-100 text-neutral-900'
          }`}
        >
          {showStop() ? '■' : '↑'}
        </button>
      </div>
    </div>
  )
}
