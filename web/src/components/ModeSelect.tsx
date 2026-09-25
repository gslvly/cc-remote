import { For, Show } from 'solid-js'
import type { PermissionMode, SwitchableMode } from '../../../shared/protocol'
import { MODE_LABEL, MODES } from '../format'

// 配色大致照终端：规划青、接受编辑紫、跳过审批红
const MODE_CLASS: Partial<Record<PermissionMode, string>> = {
  plan: 'border-sky-700 text-sky-300',
  acceptEdits: 'border-violet-700 text-violet-300',
  bypassPermissions: 'border-red-800 text-red-300',
}

/**
 * 权限模式（终端里的 Shift+Tab）。用原生 select，手机上弹的是系统选择器。
 * value 为空时显示 unset；auto 这类手机上不提供的模式，正处在它时也照样显示出来。
 * 选项归在「权限模式」标题下；unset 只在 unsetSelectable 时能选，否则只是占位，不进列表
 */
export function ModeSelect(props: {
  value?: PermissionMode
  unset: string
  unsetSelectable?: boolean
  disabled?: boolean
  /** 返回的 Promise 不要 reject */
  onChange: (mode: SwitchableMode | undefined) => unknown
  class?: string
}) {
  const extra = () => (props.value && !(MODES as PermissionMode[]).includes(props.value) ? props.value : undefined)
  return (
    <select
      value={props.value ?? ''}
      disabled={props.disabled}
      aria-label="权限模式"
      onChange={(e) => {
        const el = e.currentTarget
        // 切成功了 value 跟着变；失败了（错误由调用方显示）回到原来的
        void Promise.resolve(props.onChange((el.value || undefined) as SwitchableMode | undefined)).finally(
          () => (el.value = props.value ?? ''),
        )
      }}
      class={`appearance-none rounded-full border bg-neutral-900 px-3 text-center text-sm outline-none [text-align-last:center] disabled:opacity-40 ${
        (props.value && MODE_CLASS[props.value]) || 'border-neutral-700 text-neutral-400'
      } ${props.class ?? ''}`}
    >
      <Show when={!props.unsetSelectable}>
        <option value="" disabled hidden>
          {props.unset}
        </option>
      </Show>
      <optgroup label="权限模式">
        <Show when={props.unsetSelectable}>
          <option value="">{props.unset}</option>
        </Show>
        <For each={MODES}>{(m) => <option value={m}>{MODE_LABEL[m]}</option>}</For>
        <Show when={extra()}>
          {(m) => (
            <option value={m()} disabled>
              {MODE_LABEL[m()]}
            </option>
          )}
        </Show>
      </optgroup>
    </select>
  )
}
