import { createSignal } from 'solid-js'

export type Route =
  | { page: 'login' }
  | { page: 'home' }
  | { page: 'dir'; path: string }
  | { page: 'session'; id: string }

function parse(hash: string): Route {
  const [path = '', query = ''] = hash.replace(/^#/, '').split('?')
  const params = new URLSearchParams(query)
  if (path === '/login') return { page: 'login' }
  if (path === '/dir') return { page: 'dir', path: params.get('path') ?? '' }
  const m = path.match(/^\/s\/([\w-]+)$/)
  if (m) return { page: 'session', id: m[1]! }
  return { page: 'home' }
}

const [hash, setHash] = createSignal(location.hash)
// 前进后退、手动改地址栏
addEventListener('popstate', () => setHash(location.hash))
addEventListener('hashchange', () => setHash(location.hash))

/** 当前路由（响应式） */
export const route = () => parse(hash())

/**
 * 换路由一律走这里。不要用 location.hash = / location.replace('#…')：iOS 27 主屏 web app 上这种哈希导航
 * 每次都会整屏闪一下白（真机二分确认，空页面也闪；pushState / replaceState 不闪）。
 * history API 不触发 hashchange，改完 URL 自己更新路由。
 * 应用内推进来的记录带 inApp，返回时据此判断上一条是不是自己的页面；replace 保留原来的标记
 */
export function navigate(to: string, replace = false) {
  if (to === location.hash) return
  if (replace) history.replaceState(history.state, '', to)
  else history.pushState({ inApp: true }, '', to)
  setHash(location.hash)
}

export const go = {
  home: () => navigate('#/'),
  /** 回上一页（首页或目录页）；直接打开的、上一条不是应用内的，回首页 */
  back: () => (history.state?.inApp ? history.back() : navigate('#/', true)),
  login: () => navigate('#/login'),
  /** 目录页：新建会话、该目录的历史会话 */
  dir: (path: string) => navigate(`#/dir?path=${encodeURIComponent(path)}`),
  /** 标签条之间切换用 replace，不然返回键要把切过的会话挨个退一遍 */
  session: (id: string, replace = false) => navigate(`#/s/${id}`, replace),
}
