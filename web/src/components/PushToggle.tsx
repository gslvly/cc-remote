import { createSignal, Match, Switch } from 'solid-js'
import { disablePush, enablePush, pushState } from '../notify'

const PILL = 'shrink-0 rounded-md border px-2 py-0.5 text-xs disabled:opacity-50'

/** 首页标题旁的系统通知开关；这个环境用不了网页推送（非 HTTPS 等）时不显示 */
export function PushToggle() {
  const [busy, setBusy] = createSignal(false)
  // 开启时 enablePush 要在点击里同步调起，中间不能先 await 别的
  const run = (fn: () => Promise<string | undefined>, failed: string) => {
    setBusy(true)
    void fn().then((err) => {
      setBusy(false)
      if (err) alert(`${failed}：${err}`)
    })
  }

  return (
    <Switch>
      <Match when={pushState() === 'off'}>
        <button disabled={busy()} onClick={() => run(enablePush, '开启通知失败')} class={`${PILL} border-amber-700/60 text-amber-300`}>
          开启通知
        </button>
      </Match>
      <Match when={pushState() === 'on'}>
        <button
          disabled={busy()}
          onClick={() => confirm('关闭这台设备的系统通知？') && run(disablePush, '关闭通知失败')}
          class={`${PILL} border-neutral-800 text-neutral-500`}
        >
          通知已开
        </button>
      </Match>
      <Match when={pushState() === 'denied'}>
        <button
          onClick={() => alert('通知权限被拒绝过，要到系统设置的「通知」里给 cc-remote 打开')}
          class={`${PILL} border-neutral-800 text-neutral-500`}
        >
          通知已拒绝
        </button>
      </Match>
    </Switch>
  )
}
