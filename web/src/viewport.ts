/**
 * 让整页高度跟着可见区域（visualViewport）走，弹出键盘时页面本身就落在键盘上方。返回取消函数。
 *
 * iOS 弹键盘不缩布局视口，h-dvh 还是整屏高，系统把整页往上推一个键盘高度让输入框露出来；
 * 页面本身没那么高，这段位移是越界的，之后内容一变（新回答到了、消息区滚到底）WebKit 重新排版就把它收回 0，
 * 输入框掉到键盘下面。Android Chrome 108 起也只缩可见区域，同样的问题。
 *
 * 做法：--vvh 设成可见区域高度（页面用它当高度），窗口滚回顶部，不靠系统推。
 * 键盘弹起时底部没有 Home 条，--safe-bottom 设成 0，输入框下面不留安全区的空白。
 * 双指缩放时可见区域也会变，那时不跟（scale 不是 1）
 *
 * 整页本身不滚也不回弹（overflow hidden + overscroll-behavior none），只有页面里的消息区滚：
 * 不然 iOS 上手指按在页头 / 输入框，或消息区滚到头了，拖动会落到整页上，整页回弹时的 scroll 又被这里拽回 0，来回抖
 */
export function fitViewport(): () => void {
  const vv = window.visualViewport
  if (!vv) return () => {}
  const root = document.documentElement
  root.style.overflow = 'hidden'
  root.style.overscrollBehavior = 'none'
  const update = () => {
    if (Math.abs(vv.scale - 1) > 0.01) return
    root.style.setProperty('--vvh', `${vv.height}px`)
    // 布局视口（html 的 clientHeight）不随键盘变，可见区域比它矮一大截就是键盘弹着
    if (root.clientHeight - vv.height > 80) root.style.setProperty('--safe-bottom', '0px')
    else root.style.removeProperty('--safe-bottom')
    if (window.scrollY || vv.offsetTop) window.scrollTo(0, 0)
  }
  update()
  vv.addEventListener('resize', update)
  vv.addEventListener('scroll', update)
  return () => {
    vv.removeEventListener('resize', update)
    vv.removeEventListener('scroll', update)
    root.style.removeProperty('--vvh')
    root.style.removeProperty('--safe-bottom')
    root.style.removeProperty('overflow')
    root.style.removeProperty('overscroll-behavior')
  }
}
