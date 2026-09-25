import { createMemo, For, onMount, Show } from 'solid-js'
import type { SessionInfo } from '../../../shared/protocol'
import { sessionLabel } from '../overview'
import { go } from '../router'
import { StateDot } from './StateBadge'

/**
 * 会话页顶部：全部会话的标签（可横滑，带状态点；终端里的会话是 ▣，只读），最右 [+] 回首页选目录新建。
 * 当前标签带 ×；终端里正跑着的归终端管，没有
 */
export function TabBar(props: { current: string; sessions: readonly SessionInfo[]; onClose: () => unknown }) {
  // 按创建先后排，标签位置不随活动跳来跳去
  const tabs = createMemo(() => [...props.sessions].sort((a, b) => a.createdAt - b.createdAt))
  let strip: HTMLDivElement | undefined

  // 当前标签滚到可见处（从别的标签、横幅跳过来时，它可能在屏幕外）
  onMount(() => strip?.querySelector('[aria-current="page"]')?.scrollIntoView({ inline: 'nearest', block: 'nearest' }))

  return (
    <nav class="flex items-center border-b border-neutral-800 pt-[env(safe-area-inset-top)]">
      <div ref={strip} class="flex min-w-0 flex-1 gap-1 overflow-x-auto px-2 py-1.5 [scrollbar-width:none]">
        <For each={tabs()}>
          {(s) => {
            const current = () => s.id === props.current
            const closable = () => current() && s.terminal !== 'running'
            return (
              <div
                class={`flex shrink-0 items-center rounded-full text-sm ${
                  current() ? 'bg-neutral-800 text-neutral-100' : 'text-neutral-400'
                }`}
              >
                <button
                  onClick={() => !current() && go.session(s.id, true)}
                  aria-current={current() ? 'page' : undefined}
                  title={s.title}
                  class={`flex items-center gap-1.5 py-1.5 pl-3 ${closable() ? 'pr-1' : 'pr-3'}`}
                >
                  <StateDot state={s.state} terminal={s.terminal} />
                  <span class="max-w-32 truncate">{sessionLabel(s, props.sessions)}</span>
                </button>
                <Show when={closable()}>
                  <button
                    onClick={() => props.onClose()}
                    aria-label="关闭会话"
                    class="grid size-7 place-items-center rounded-full pr-0.5 text-base leading-none text-neutral-400 active:bg-neutral-700"
                  >
                    ×
                  </button>
                </Show>
              </div>
            )
          }}
        </For>
      </div>
      <button
        onClick={go.home}
        aria-label="新建会话"
        class="grid size-11 shrink-0 place-items-center border-l border-neutral-800 text-2xl leading-none text-neutral-400"
      >
        +
      </button>
    </nav>
  )
}

/** 别的会话在等批准时，在消息区上方提示，一键跳过去。终端会话在等操作也没法在手机上批，不提示 */
export function ApprovalBanner(props: { current: string; sessions: readonly SessionInfo[] }) {
  const waiting = () =>
    props.sessions.filter((s) => s.id !== props.current && s.state === 'requires_action' && !s.terminal)
  return (
    <Show when={waiting()[0]}>
      {(s) => (
        <div class="mx-3 mt-2 flex items-center gap-2 rounded-xl border border-amber-700/60 bg-amber-950/70 py-1.5 pr-1.5 pl-3 text-sm">
          <span class="size-2 shrink-0 rounded-full bg-amber-400" />
          <span class="min-w-0 flex-1 truncate">
            <span class="font-medium">{sessionLabel(s(), props.sessions)}</span> 需要批准
            {waiting().length > 1 ? `（另有 ${waiting().length - 1} 个会话）` : ''}
          </span>
          <button
            onClick={() => go.session(s().id, true)}
            class="shrink-0 rounded-lg bg-amber-400 px-3 py-1 font-medium text-neutral-900"
          >
            去处理
          </button>
        </div>
      )}
    </Show>
  )
}
