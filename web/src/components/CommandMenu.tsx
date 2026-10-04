import { Errored, For, Loading, Show, untrack } from 'solid-js'
import type { Catalog, CatalogCommand } from '../../../shared/protocol'
import { cachedGet } from '../api'
import { errorText } from '../format'

/** 输入框里以 / 开头、还没打空格时，/ 后面那段；不是就是 undefined */
export const slashQuery = (text: string) => text.match(/^\/(\S*)$/)?.[1]

/** 名字、别名以输入开头的排前面，其次是包含的 */
function match(list: CatalogCommand[], input: string) {
  const q = input.toLowerCase()
  const names = (c: CatalogCommand) => [c.name, ...(c.aliases ?? [])].map((n) => n.toLowerCase())
  const head = list.filter((c) => names(c).some((n) => n.startsWith(q)))
  return [...head, ...list.filter((c) => !head.includes(c) && names(c).some((n) => n.includes(q)))]
}

/**
 * 打 / 时弹出的命令列表：Claude Code 自己的命令和各处的 skill（服务端已滤掉手机上不该用的），点一下填进输入框。
 * 展示类的（/context、/usage 等）发出去回一段 markdown，照常显示在消息流里
 */
export function CommandMenu(props: { cwd: string; query: string; onPick: (name: string) => void }) {
  const cat = cachedGet<Catalog>(`/catalog?cwd=${encodeURIComponent(untrack(() => props.cwd))}`)
  const list = () => match(cat().commands, props.query)
  return (
    // 按下时不抢焦点：输入框不失焦，手机键盘不收起
    <div
      aria-label="命令列表"
      onPointerDown={(e) => e.preventDefault()}
      class="mb-2 max-h-[40dvh] overflow-y-auto rounded-xl border border-neutral-800 bg-neutral-900"
    >
      <Errored fallback={(err) => <p class="px-3 py-2 text-xs text-red-400">{errorText(err())}</p>}>
        <Loading fallback={<p class="px-3 py-2 text-xs text-neutral-500">取命令列表…</p>}>
          <For each={list()} fallback={<p class="px-3 py-2 text-xs text-neutral-500">没有匹配的命令</p>}>
            {(c) => (
              <button onClick={() => props.onPick(c.name)} class="block w-full px-3 py-1.5 text-left active:bg-neutral-800">
                <span class="font-mono text-sm text-neutral-200">/{c.name}</span>
                <Show when={c.argumentHint}>
                  <span class="ml-2 font-mono text-xs text-neutral-500">{c.argumentHint}</span>
                </Show>
                <span class="block truncate text-xs text-neutral-500">{c.description}</span>
              </button>
            )}
          </For>
        </Loading>
      </Errored>
    </div>
  )
}
