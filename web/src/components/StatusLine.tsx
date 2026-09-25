// 状态栏：项目同终端的 statusline（模型一项在标题下面那行），排成手机上的四格，每格上面是数值、下面是 k 数或倒计时：
//   上下文 45%   缓存 98%   5h 剩66%   7d 剩88%
//   450k         52m        2h13m      3d4h
// 快满、命中率低、缓存过期、额度快用完时变色；倒计时每秒走（终端 statusline 只在重新执行时刷新）
import { For, Show } from 'solid-js'
import type { Quota, SessionInfo } from '../../../shared/protocol'
import { now } from '../clock'
import { cacheParts, ctxParts, quotaParts } from '../status'

const WARN = 'text-amber-400'
const BAD = 'text-red-400'

function Metric(props: { label: string; value: string; tone?: string; sub?: string; subTone?: string }) {
  return (
    <div class="flex min-w-0 flex-col whitespace-nowrap">
      <span>
        <span class="text-neutral-500">{props.label} </span>
        <span class={props.tone || 'text-neutral-300'}>{props.value}</span>
      </span>
      <span class={`text-[10px] leading-3 ${props.subTone || 'text-neutral-500'}`}>{props.sub ?? ' '}</span>
    </div>
  )
}

const WINDOWS = [
  ['five_hour', '5h'],
  ['seven_day', '7d'],
] as const

/** 5h / 7d 剩余和距重置。还不知道的窗口不显示（额度只来自托管会话的 rate_limit_event）。首页也用 */
export function QuotaText(props: { quota: Quota | null }) {
  return (
    <For each={WINDOWS}>
      {([w, label]) => (
        <Show when={quotaParts(props.quota?.[w], now())}>
          {(q) => <Metric label={label} value={`剩${q().left}%`} tone={q().left <= 5 ? BAD : q().left <= 20 ? WARN : ''} sub={q().resets} />}
        </Show>
      )}
    </For>
  )
}

export function StatusLine(props: { info: SessionInfo; quota: Quota | null }) {
  const ctx = () => ctxParts(props.info.usage, props.info.contextWindow)
  const cache = () => cacheParts(props.info.usage, now())
  return (
    <div aria-label="状态栏" class="grid grid-cols-4 gap-x-2 border-b border-neutral-800 px-4 py-1 text-[11px] tabular-nums">
      <Show when={props.info.usage} fallback={<Metric label="上下文" value="--" />}>
        <Metric
          label="上下文"
          value={`${ctx().pct ?? '--'}%`}
          tone={(ctx().pct ?? 0) >= 90 ? BAD : (ctx().pct ?? 0) >= 70 ? WARN : ''}
          sub={`${ctx().k}k`}
        />
      </Show>
      <Show when={cache()} fallback={<Metric label="缓存" value="--" />}>
        {/* 命中率低：这次大量重算，偏贵；过期了：下一条消息要重新写缓存 */}
        {(c) => (
          <Metric label="缓存" value={`${c().hit}%`} tone={c().hit <= 50 ? WARN : ''} sub={c().left ?? '已过期'} subTone={c().left ? '' : WARN} />
        )}
      </Show>
      <QuotaText quota={props.quota} />
    </div>
  )
}
