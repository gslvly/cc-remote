import { createEffect, createSignal, For, on, onCleanup, Show } from 'solid-js'
import { Composer } from '../components/Composer'
import { ItemView, LiveView } from '../components/ItemView'
import { PermissionSheet, type SheetProps } from '../components/PermissionSheet'
import { PlanSheet } from '../components/PlanSheet'
import { QuestionSheet } from '../components/QuestionSheet'
import { StateBadge } from '../components/StateBadge'
import { StatusLine } from '../components/StatusLine'
import { ApprovalBanner, TabBar } from '../components/TabBar'
import { TerminalBar } from '../components/TerminalBar'
import { TodoBar } from '../components/TodoBar'
import { basename, errorText } from '../format'
import { afterPaint } from '../frame'
import { useOverview, useQuota } from '../overview'
import { go } from '../router'
import { openSession } from '../session/store'
import { modelLabel } from '../status'
import { TODO_TOOLS } from '../session/view'

export function SessionPage(props: { id: string }) {
  const s = openSession(props.id)
  onCleanup(s.detach)
  const all = useOverview()
  const quota = useQuota()
  const { view } = s
  let scroller: HTMLDivElement | undefined
  let stick = true

  // 切页、回前台都会重连，一般一两百毫秒：这期间照旧显示缓存的状态，断开超过 1 秒才换成「连接中…」
  const [slow, setSlow] = createSignal(false)
  createEffect(() => {
    if (s.conn() === 'open') {
      setSlow(false)
      return
    }
    const t = setTimeout(() => setSlow(true), 1000)
    onCleanup(() => clearTimeout(t))
  })

  // 在底部附近时跟随新内容（包括正在蹦的字）；用户往上翻了就不打扰。切回缓存里的会话时也从底部开始。
  // 等新内容画出来再滚（见 afterPaint），排着的滚动一次就够。离底部超过一屏（刚进来、历史刚到）先藏起消息区，
  // 不然会露一帧对话开头；滚完的下一帧再露出来，露出和滚动也不挤在同一帧
  const [hidden, setHidden] = createSignal(false)
  let following = false
  createEffect(
    on([() => view.lastSeq, s.live], () => {
      const el = scroller
      if (!el || !stick) return
      if (el.scrollHeight - el.scrollTop - el.clientHeight > el.clientHeight) setHidden(true)
      if (following) return
      following = true
      afterPaint(() => {
        following = false
        if (stick) el.scrollTop = el.scrollHeight
        requestAnimationFrame(() => setHidden(false))
      })
    }),
  )

  // 往前补一页：内容加在上面，保持离底部的距离不变，眼前的消息不跳。
  // 浏览器的滚动锚定（Safari 27 起也有）多半已经保持住了，没保持住才自己滚，少一次同帧滚动
  const loadOlder = async () => {
    if (!scroller) return
    const fromBottom = scroller.scrollHeight - scroller.scrollTop
    await s.loadOlder()
    const top = scroller.scrollHeight - fromBottom
    if (Math.abs(scroller.scrollTop - top) > 1) scroller.scrollTop = top
  }

  // 关掉会话回首页；Claude 正在干活的先确认
  // 历史会话没进概览流、也没子进程：服务端的 dismiss 是 no-op，直接回首页
  const close = async () => {
    const st = s.info()?.state
    const busy = st === 'starting' || st === 'running' || st === 'requires_action'
    if (busy && !confirm('Claude 正在运行，关闭会中断。确定关闭？')) return
    const listed = all.some((x) => x.id === props.id)
    if (listed || s.info()?.live || s.info()?.terminal) {
      try {
        await s.actions.close()
      } catch (e) {
        alert(errorText(e))
        return
      }
    }
    go.home()
  }

  // Todo / Task 工具不进消息流，生成参数时也不显示
  const live = () => {
    const b = s.live()
    return b?.kind === 'tool' && TODO_TOOLS.has(b.name) ? null : b
  }

  return (
    <Show
      when={s.conn() !== 'gone'}
      fallback={
        <div class="flex min-h-dvh flex-col items-center justify-center gap-4 px-6 text-center">
          <p class="text-neutral-400">会话不存在，或者它的目录不在 roots 内</p>
          <button onClick={go.home} class="rounded-lg border border-neutral-700 px-4 py-2">
            回首页
          </button>
        </div>
      }
    >
      <div class="mx-auto flex h-dvh max-w-2xl flex-col">
        <TabBar current={props.id} sessions={all} currentInfo={s.info()} onClose={close} />
        <header class="flex items-center gap-2 border-b border-neutral-800 px-4 py-2">
          <div class="min-w-0 flex-1">
            <h1 class="truncate text-sm font-medium">{s.info()?.title ?? '…'}</h1>
            {/* 目录 · 模型 · 上下文上限 · effort；权限模式在输入框左边 */}
            <p class="min-h-4 truncate text-xs text-neutral-500">{s.info() ? [basename(s.info()!.cwd), modelLabel(s.info()!)].filter(Boolean).join(' · ') : ''}</p>
          </div>
          <Show
            when={!slow() && s.info()}
            fallback={<span class={`text-xs text-neutral-500 ${slow() ? '' : 'invisible'}`}>连接中…</span>}
          >
            {(i) => <StateBadge state={i().state} terminal={i().terminal} />}
          </Show>
        </header>
        <Show
          when={s.info()}
          fallback={
            <div
              aria-hidden="true"
              class="invisible grid grid-cols-4 gap-x-2 border-b border-neutral-800 px-4 py-1 text-[11px] tabular-nums"
            >
              <For each={['上下文 --', '缓存 --', '5h', '7d']}>
                {(t) => (
                  <div class="flex min-w-0 flex-col whitespace-nowrap">
                    <span>{t}</span>
                    <span class="text-[10px] leading-3">{' '}</span>
                  </div>
                )}
              </For>
            </div>
          }
        >
          {(i) => <StatusLine info={i()} quota={quota()} />}
        </Show>
        <ApprovalBanner current={props.id} sessions={all} />
        <TodoBar todos={view.todos} />

        <div
          ref={scroller}
          onScroll={(e) => {
            const el = e.currentTarget
            stick = el.scrollHeight - el.scrollTop - el.clientHeight < 80
            if (el.scrollTop < 300 && s.more() && !s.loadingOlder()) void loadOlder()
          }}
          class={`flex-1 space-y-3 overflow-y-auto px-4 py-4 ${hidden() ? 'invisible' : ''}`}
        >
          <Show when={s.more()}>
            <button
              onClick={() => void loadOlder()}
              disabled={s.loadingOlder()}
              class="block w-full py-1 text-center text-xs text-neutral-500"
            >
              {s.loadingOlder() ? '加载中…' : '更早的消息'}
            </button>
          </Show>
          <For each={view.items}>{(item) => <ItemView item={item} sub={view.sub} />}</For>
          <Show when={live()}>{(b) => <LiveView block={b()} />}</Show>
          <Show when={view.compacting}>
            <p class="animate-pulse text-xs text-neutral-500">压缩对话中…</p>
          </Show>
          <Show when={view.pending.length}>
            <div class="h-[45dvh]" />
          </Show>
        </div>

        {/* 终端会话没有输入框：终端还在就只读，退出了可以接管 */}
        <Show
          when={s.info()?.terminal && s.info()}
          fallback={
            <Composer
              state={s.info()?.state ?? 'starting'}
              mode={s.info()?.permissionMode}
              onSend={s.actions.send}
              onInterrupt={s.actions.interrupt}
              onMode={s.actions.setMode}
            />
          }
        >
          {(i) => <TerminalBar info={i()} onTakeover={s.actions.takeover} />}
        </Show>

        {/* 按请求 id 重建弹层，上一个请求的 busy / 报错不会带到下一个。提问、计划各有自己的弹层 */}
        <Show when={view.pending[0]?.id} keyed>
          {(reqId) => {
            const sheet: SheetProps = {
              req: view.pending[0]!,
              get more() {
                return view.pending.length - 1
              },
              onDecide: (d) => s.actions.decide(reqId, d),
            }
            if (sheet.req.toolName === 'AskUserQuestion') return <QuestionSheet {...sheet} />
            if (sheet.req.toolName === 'ExitPlanMode') return <PlanSheet {...sheet} />
            return <PermissionSheet {...sheet} />
          }}
        </Show>
      </div>
    </Show>
  )
}
