// 版本更新：构建号比对 + Service Worker。
// 发现新版本时，页面上没有未发送的输入就直接刷新，否则在顶部提示，由用户点刷新。
import { createSignal } from 'solid-js'

const RELOADED_FOR = 'ccr-reloaded-for'

/** 有新版本但没自动刷新（输入框里有内容），顶部横幅据此显示 */
export const [stale, setStale] = createSignal(false)
export const dismissUpdate = () => setStale(false)

// 输入框里有没发出去的内容（消息、prompt、token…）就不自动刷新。
// 只看文字输入框：过滤框（search）、Markdown 任务列表里的勾选框不算
const hasDraft = () =>
  [...document.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>('input, textarea')].some(
    (el) => ['text', 'password', 'textarea'].includes(el.type) && el.value.trim() !== '',
  )

/** 比对响应头里服务端当前的构建号；api() 每次收到响应都会调 */
export function checkBuild(res: Response) {
  const server = res.headers.get('x-ccr-build')
  if (import.meta.env.DEV || !server || server === __BUILD_ID__) return
  // 为这个构建号刷新过、却还是旧页面（比如被缓存挡住），就别再自动刷新，免得死循环
  if (hasDraft() || sessionStorage.getItem(RELOADED_FOR) === server) return setStale(true)
  sessionStorage.setItem(RELOADED_FOR, server)
  location.reload()
}

const checkNow = () => fetch('/api/build').then(checkBuild, () => {})

export function initUpdate() {
  if (import.meta.env.DEV) return
  let reg: ServiceWorkerRegistration | undefined

  // SW 只在安全上下文（HTTPS 或 localhost）可用；http://100.x 访问时只靠构建号比对
  if ('serviceWorker' in navigator && isSecureContext) {
    navigator.serviceWorker.register('/sw.js').then(
      (r) => (reg = r),
      (e) => console.warn('[sw] 注册失败', e),
    )
    // 新 SW 接管后要刷新，但不无条件刷：首次安装（clients.claim）也会触发；构建号比对刚刷过一次的页面，
    // 新 SW 随后接管时又会触发。交给构建号比对决定，页面已是新版本就不动
    navigator.serviceWorker.addEventListener('controllerchange', checkNow)
  }

  // iOS 主屏 PWA 从后台切回来不会重新加载：回到前台时主动比对，并让浏览器检查 sw.js 有没有更新
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible') return
    void checkNow()
    reg?.update().catch(() => {})
  })
}
