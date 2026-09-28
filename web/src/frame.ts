/**
 * 等 DOM 的这次变化画出来之后，下一帧再执行。
 *
 * 规则：凡是用代码滚动——设 scrollTop / scrollLeft、调 scrollTo / scrollBy / scrollIntoView、
 * 调 focus()（会带出滚动；可以传 preventScroll 就不算）——只要同一轮里 DOM 刚变过（挂载、切页、数据到了、列表重渲染），
 * 就放进 afterPaint 里做，不要在 onMount / createEffect 里直接滚。
 *
 * 原因：iOS 27 主屏 web app（不管从 Safari 还是 Chrome 加的，都跑系统 WebKit）上，
 * DOM 刚变、同一帧里用代码滚动，整屏会闪一下白。WebKit 只修了 window.scrollTo 的这种情况
 * （Safari 27 发布说明，bug 173197381），元素滚动、scrollIntoView 还会闪。桌面浏览器、Playwright 都复现不了，只能真机看。
 *
 * 实现：第一个 rAF 那一帧画出 DOM 的变化，第二个 rAF 才滚。
 * 推迟会让内容先在原位置停一帧；位置差得远时（比如会话页刚进来要滚到底），先把区域藏起来，滚完的下一帧再露出，
 * 露出和滚动也别挤在同一帧（做法见 pages/Session.tsx 跟随到底部那段）
 */
export function afterPaint(fn: () => void) {
  requestAnimationFrame(() => requestAnimationFrame(fn))
}
