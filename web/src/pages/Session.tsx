import { createEffect, createSignal, For, onSettled, Show, untrack } from 'solid-js'
import { Composer } from '../components/Composer'
import { ItemView, LiveView } from '../components/ItemView'
import { ModelSheet } from '../components/ModelSheet'
import { PermissionSheet, type SheetProps } from '../components/PermissionSheet'
import { PlanSheet } from '../components/PlanSheet'
import { QuestionSheet } from '../components/QuestionSheet'
import { RewindSheet } from '../components/RewindSheet'
import { StateBadge } from '../components/StateBadge'
import { StatusLine } from '../components/StatusLine'
import { ApprovalBanner, TabBar } from '../components/TabBar'
import { TerminalBar } from '../components/TerminalBar'
import { TodoBar } from '../components/TodoBar'
import { basename, errorText, MODE_LABEL, MODE_TEXT } from '../format'
import { afterPaint } from '../frame'
import { useOverview, useQuota } from '../overview'
import { go } from '../router'
import { openSession } from '../session/store'
import { modelLabel } from '../status'
import { TODO_TOOLS, type UserItem } from '../session/view'
import { fitViewport } from '../viewport'

export function SessionPage(props: { id: string }) {
  // 换会话时整页重建（App 里 keyed），id 只取一次
  const s = openSession(untrack(() => props.id))
  // 连流会写连接状态，组件体里不能写：挂上之后再连，销毁时断开
  onSettled(() => {
    s.attach()
    return s.detach
  })
  // 整页高度跟着键盘上方的可见区域（见 viewport.ts）
  onSettled(fitViewport)
  const all = useOverview()
  const quota = useQuota()
  const { view } = s
  let scroller: HTMLDivElement | undefined
  let stick = true
  /** 上一次滚动事件时的 scrollTop，分辨是不是往上翻 */
  let lastTop = 0
  /** 只打开看、还没续接的历史会话：不在标签条里，页头标「历史」，发消息就续接 */
  const history = () => {
    const i = s.info()
    return !!i && !i.owned && !i.terminal
  }

  /** 切模型的弹层开着 */
  const [picking, setPicking] = createSignal(false)
  /** 要回退到哪条之前（弹层开着）；回退完把它的原文放回输入框 */
  const [rewinding, setRewinding] = createSignal<UserItem>()
  const [fill, setFill] = createSignal<{ text: string }>()
  /** 空闲、终端没占着才能回退 */
  const rewindable = () => {
    const i = s.info()
    return i?.state === 'idle' && !i.terminal
  }

  // 切页、回前台都会重连，一般一两百毫秒：这期间照旧显示缓存的状态，断开超过 1 秒才换成「连接中…」
  const [slow, setSlow] = createSignal(false)
  createEffect(
    () => s.conn() === 'open',
    (open) => {
      if (open) {
        setSlow(false)
        return
      }
      const t = setTimeout(() => setSlow(true), 1000)
      return () => clearTimeout(t)
    },
  )

  // 在底部附近时跟随新内容（包括正在蹦的字）；用户往上翻了就不打扰。切回缓存里的会话时也从底部开始。
  // 等新内容画出来再滚（见 afterPaint），排着的滚动一次就够。离底部超过一屏（刚进来、历史刚到）先藏起消息区，
  // 不然会露一帧对话开头；滚完的下一帧再露出来，露出和滚动也不挤在同一帧
  const [hidden, setHidden] = createSignal(false)
  let following = false
  const follow = () => {
    if (following) return
    following = true
    afterPaint(() => {
      following = false
      if (stick && scroller) scroller.scrollTop = scroller.scrollHeight
      requestAnimationFrame(() => setHidden(false))
    })
  }
  createEffect(
    () => [view.lastSeq, s.live()],
    () => {
      const el = scroller
      if (!el || !stick) return
      if (el.scrollHeight - el.scrollTop - el.clientHeight > el.clientHeight) setHidden(true)
      follow()
    },
  )
  // 消息区变矮（弹键盘、输入框长高）时 scrollTop 不变，底部几条会被盖住：原本贴着底就继续贴着
  onSettled(() => {
    if (!scroller) return
    const ro = new ResizeObserver(() => stick && follow())
    ro.observe(scroller)
    return () => ro.disconnect()
  })

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
      <div class="mx-auto flex h-[var(--vvh,100dvh)] max-w-2xl flex-col">
        <TabBar current={props.id} cwd={s.info()?.cwd} sessions={all} onClose={close} />
        <header class="flex items-center gap-2 border-b border-neutral-800 px-4 py-2">
          <div class="min-w-0 flex-1">
            <h1 class="truncate text-sm font-medium">{s.info()?.title ?? '…'}</h1>
            {/* 目录 · 模型 · 上下文上限 · effort · 权限模式（默认的不显示），点模型或模式那段弹出切换（终端会话只读） */}
            <p class="min-h-4 truncate text-xs text-neutral-500">
              <Show when={s.info()}>
                {(i) => (
                  <>
                    {basename(i().cwd)} ·{' '}
                    <button
                      onClick={() => setPicking(true)}
                      disabled={!!i().terminal}
                      class="underline decoration-neutral-700 decoration-dotted underline-offset-2 disabled:no-underline"
                    >
                      {modelLabel(i()) || '模型'}
                    </button>
                    <Show when={i().permissionMode !== 'default' && i().permissionMode}>
                      {(m) => (
                        <>
                          {' · '}
                          <button onClick={() => setPicking(true)} disabled={!!i().terminal} class={MODE_TEXT[m()] ?? ''}>
                            {MODE_LABEL[m()]}
                          </button>
                        </>
                      )}
                    </Show>
                  </>
                )}
              </Show>
            </p>
          </div>
          <Show
            when={!slow() && s.info()}
            fallback={<span class={`text-xs text-neutral-500 ${slow() ? '' : 'invisible'}`}>连接中…</span>}
          >
            {(i) => <StateBadge state={i().state} terminal={i().terminal} history={history()} />}
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
            // 回到底部附近就跟随；离开底部只认往上翻。代码滚到底之后、滚动事件到达之前（差一帧），
            // 紧跟着到的内容（命令输出、不带思考的回答）可能已经撑高一大截，按离底距离算会误判成用户翻走了，之后就不再跟
            if (el.scrollHeight - el.scrollTop - el.clientHeight < 80) stick = true
            else if (el.scrollTop < lastTop) stick = false
            lastTop = el.scrollTop
            if (el.scrollTop < 300 && s.more() && !s.loadingOlder()) void loadOlder()
          }}
          class={`flex-1 space-y-3 overflow-y-auto overscroll-contain px-4 py-4 ${hidden() ? 'invisible' : ''}`}
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
          <For each={view.items}>
            {(item) => <ItemView item={item} sub={view.sub} onRewind={rewindable() ? setRewinding : undefined} />}
          </For>
          <Show when={live()}>{(b) => <LiveView block={b()} />}</Show>
          <Show when={view.compacting}>
            <p class="animate-pulse text-xs text-neutral-500">压缩对话中…</p>
          </Show>
          <Show when={view.pending.length}>
            <div class="h-[45dvh]" />
          </Show>
        </div>

        {/* 终端还占着的会话没有输入框，只读；终端放手后就是历史会话，输入框出现 */}
        <Show
          when={s.info()?.terminal}
          fallback={
            <Composer
              state={s.info()?.state ?? 'starting'}
              mode={s.info()?.permissionMode}
              history={history()}
              cwd={s.info()?.cwd}
              draftKey={props.id}
              fill={fill()}
              onSend={(text, images) => {
                // 自己发的东西要看到回应：往上翻着也回到跟随
                stick = true
                return s.actions.send(text, images)
              }}
              onBash={(cmd) => {
                stick = true
                return s.actions.bash(cmd)
              }}
              onInterrupt={s.actions.interrupt}
            />
          }
        >
          <TerminalBar />
        </Show>

        <Show when={picking() && s.info()}>
          {(i) => (
            <ModelSheet
              cwd={i().cwd}
              model={i().model}
              effort={i().effort}
              mode={i().permissionMode}
              onModel={(model) => s.actions.setModel({ model })}
              onEffort={(effort) => s.actions.setModel({ effort: effort ?? null })}
              onMode={(m) => m && s.actions.setMode(m)}
              onClose={() => setPicking(false)}
            />
          )}
        </Show>

        <Show when={rewinding()} keyed>
          {(item) => (
            <RewindSheet
              text={item.text}
              cwd={s.info()?.cwd ?? ''}
              preview={() => s.actions.rewind(item.uuid!, 'both', true)}
              onRewind={async (restore) => {
                await s.actions.rewind(item.uuid!, restore)
                if (restore !== 'code') setFill({ text: item.text })
                setRewinding(undefined)
              }}
              onClose={() => setRewinding(undefined)}
            />
          )}
        </Show>

        {/* 按请求 id 重建弹层，上一个请求的 busy / 报错不会带到下一个。提问、计划各有自己的弹层 */}
        <Show when={view.pending[0]?.id} keyed>
          {(reqId) => {
            const sheet: SheetProps = {
              req: untrack(() => view.pending[0]!),
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
