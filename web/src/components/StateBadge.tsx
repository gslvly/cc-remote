import { Show } from 'solid-js'
import type { SessionInfo, SessionState } from '../../../shared/protocol'

const LABEL: Record<SessionState, string> = {
  starting: '启动中',
  running: '运行中',
  requires_action: '待批准',
  idle: '空闲',
}

/** 终端会话在手机上只能看：waiting 是终端在等人操作，不一定是审批 */
const TERMINAL_LABEL: Record<SessionState, string> = {
  starting: '终端启动中',
  running: '终端运行中',
  requires_action: '终端等待操作',
  idle: '终端空闲',
}

export const DOT: Record<SessionState, string> = {
  starting: 'bg-sky-400 animate-pulse',
  running: 'bg-sky-400 animate-pulse',
  requires_action: 'bg-amber-400',
  idle: 'bg-emerald-500',
}

const GLYPH: Record<SessionState, string> = {
  starting: 'text-sky-400 animate-pulse',
  running: 'text-sky-400 animate-pulse',
  requires_action: 'text-amber-400',
  idle: 'text-emerald-500',
}

/** 状态点；终端会话用 ▣（只读），终端退出了是灰的 */
export function StateDot(props: { state: SessionState; terminal?: SessionInfo['terminal'] }) {
  return (
    <Show when={props.terminal} fallback={<span class={`size-2 shrink-0 rounded-full ${DOT[props.state]}`} />}>
      <span
        class={`shrink-0 text-xs leading-none ${props.terminal === 'exited' ? 'text-neutral-500' : GLYPH[props.state]}`}
      >
        ▣
      </span>
    </Show>
  )
}

export function StateBadge(props: { state: SessionState; terminal?: SessionInfo['terminal'] }) {
  const label = () =>
    props.terminal === 'exited' ? '终端已退出' : props.terminal ? TERMINAL_LABEL[props.state] : LABEL[props.state]
  return (
    <span class="inline-flex shrink-0 items-center gap-1.5 text-xs text-neutral-400">
      <StateDot state={props.state} terminal={props.terminal} />
      {label()}
    </span>
  )
}
