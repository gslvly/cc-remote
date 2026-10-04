// 系统通知（网页推送，服务端见 server/webpush.ts）：页面从 HTTPS 打开才有，iOS 还要 16.4+、从主屏图标打开。
// 用不了（http://<IP>、Safari 标签页、开发模式）就什么都不显示、不报错，提醒照旧靠应用内的横幅和审批弹层
import { createSignal } from 'solid-js'
import { api } from './api'
import { errorText } from './format'
import { go } from './router'

/** unsupported：这个环境用不了；off：能开、没开；on：这台设备订阅着；denied：拒绝过，只能去系统设置里改 */
export type PushState = 'unsupported' | 'off' | 'on' | 'denied'

const [state, setState] = createSignal<PushState>('unsupported')
export const pushState = state

// SW 只在生产构建里注册（见 update.ts）
const supported = () =>
  !import.meta.env.DEV && isSecureContext && 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window

/** 服务端的 VAPID 公钥（base64url 解开） */
const serverKey = async () => {
  const { key } = await api<{ key: string }>('/push/key')
  return Uint8Array.from(atob(key.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0))
}

/** 订阅时用的是不是服务端现在的公钥（服务端删了 webpush.json 会换密钥，旧订阅就作废了） */
const sameKey = (sub: PushSubscription, key: Uint8Array) => {
  const k = sub.options.applicationServerKey
  return !!k && new Uint8Array(k).join() === key.join()
}

const save = (sub: PushSubscription) => api('/push/subscribe', sub.toJSON())

/** 启动时调：同步这台设备的订阅状态，并接住点通知时 SW 发来的跳转 */
export async function initPush() {
  if (!supported()) return
  navigator.serviceWorker.addEventListener('message', (e) => {
    if (e.data?.type === 'open' && typeof e.data.session === 'string') go.session(e.data.session)
  })
  navigator.serviceWorker.startMessages()
  if (Notification.permission === 'denied') return setState('denied')
  setState('off')
  try {
    const sub = await (await navigator.serviceWorker.ready).pushManager.getSubscription()
    if (!sub || Notification.permission !== 'granted') return
    if (!sameKey(sub, await serverKey())) return void sub.unsubscribe()
    // 服务端的订阅表可能丢过，每次打开补一下
    await save(sub)
    setState('on')
  } catch {
    // 没登录、网络不通：保持 off，下次打开再同步
  }
}

/** 开启。要在点击里直接调：iOS 只认用户手势里发起的授权请求。出错返回原因 */
export async function enablePush(): Promise<string | undefined> {
  const perm = await Notification.requestPermission()
  if (perm !== 'granted') return void setState(perm === 'denied' ? 'denied' : 'off')
  try {
    const reg = await navigator.serviceWorker.ready
    const key = await serverKey()
    let sub = await reg.pushManager.getSubscription()
    if (sub && !sameKey(sub, key)) {
      await sub.unsubscribe()
      sub = null
    }
    sub ??= await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key })
    await save(sub)
    setState('on')
  } catch (e) {
    return errorText(e)
  }
}

export async function disablePush(): Promise<string | undefined> {
  try {
    const sub = await (await navigator.serviceWorker.ready).pushManager.getSubscription()
    if (sub) {
      await api('/push/unsubscribe', { endpoint: sub.endpoint })
      await sub.unsubscribe()
    }
    setState('off')
  } catch (e) {
    return errorText(e)
  }
}
