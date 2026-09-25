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
addEventListener('hashchange', () => setHash(location.hash))

/** 当前路由（响应式） */
export const route = () => parse(hash())

export const go = {
  home: () => (location.hash = '#/'),
  login: () => (location.hash = '#/login'),
  /** 目录页：新建会话、该目录的历史会话 */
  dir: (path: string) => (location.hash = `#/dir?path=${encodeURIComponent(path)}`),
  /** 标签条之间切换用 replace，不然返回键要把切过的会话挨个退一遍 */
  session: (id: string, replace = false) => (replace ? location.replace(`#/s/${id}`) : (location.hash = `#/s/${id}`)),
}
