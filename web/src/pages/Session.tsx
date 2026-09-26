import { createEffect, For, on, onCleanup, Show } from 'solid-js'
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

  // 在底部附近时跟随新内容（包括正在蹦的字）；用户往上翻了就不打扰。切回缓存里的会话时也从底部开始
  createEffect(
    on(
      [() => view.lastSeq, s.live],
      () => {
        if (scroller && stick) scroller.scrollTop = scroller.scrollHeight
      },
    ),
  )

  // 往前补一页：内容加在上面，保持离底部的距离不变，眼前的消息不跳
  const loadOlder = async () => {
    if (!scroller) return
    const fromBottom = scroller.scrollHeight - scroller.scrollTop
    await s.loadOlder()
    scroller.scrollTop = scroller.scrollHeight - fromBottom
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
            <p class="truncate text-xs text-neutral-500">{s.info() ? [basename(s.info()!.cwd), modelLabel(s.info()!)].filter(Boolean).join(' · ') : ''}</p>
          </div>
          <Show when={s.conn() === 'open' && s.info()} fallback={<span class="text-xs text-neutral-500">连接中…</span>}>
            {(i) => <StateBadge state={i().state} terminal={i().terminal} />}
          </Show>
        </header>
        <Show when={s.info()}>{(i) => <StatusLine info={i()} quota={quota()} />}</Show>
        <ApprovalBanner current={props.id} sessions={all} />
        <TodoBar todos={view.todos} />

        <div
          ref={scroller}
          onScroll={(e) => {
            const el = e.currentTarget
            stick = el.scrollHeight - el.scrollTop - el.clientHeight < 80
            if (el.scrollTop < 300 && s.more() && !s.loadingOlder()) void loadOlder()
          }}
          class="flex-1 space-y-3 overflow-y-auto px-4 py-4"
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
