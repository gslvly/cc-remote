import { api, ApiError } from './api'

/** gone：404（会话没了）；unauthorized：401，api() 已经跳到登录页 */
export type Conn = 'connecting' | 'open' | 'gone' | 'unauthorized'

export interface Stream {
  close(): void
}

/**
 * 一条 SSE 连接。断线时浏览器自己重连（带 Last-Event-ID）；非 200 时浏览器放弃，这里用 probe 查原因，
 * 服务端暂时不可用就过几秒重连。
 * 切到后台时主动断开，回到前台、网络恢复时重连（iOS 切后台后连接会被掐断，回到前台时 EventSource 未必察觉）；
 * 重连时重新取 url()，内容流借此带上最后的事件编号，只补差量。
 */
export function openStream(opts: {
  url: () => string
  /** 连不上时用它查原因（api() 的路径） */
  probe: string
  on: Record<string, (data: string) => void>
  onConn: (c: Conn) => void
}): Stream {
  let es: EventSource | undefined
  let retry: ReturnType<typeof setTimeout> | undefined
  let dead = false

  const connect = () => {
    clearTimeout(retry)
    es?.close()
    opts.onConn('connecting')
    const cur = (es = new EventSource(opts.url()))
    cur.onopen = () => opts.onConn('open')
    for (const [name, fn] of Object.entries(opts.on)) cur.addEventListener(name, (e) => fn((e as MessageEvent).data))
    cur.onerror = () => {
      if (es !== cur) return
      opts.onConn('connecting')
      if (cur.readyState !== EventSource.CLOSED) return
      api(opts.probe).then(
        () => {
          if (es === cur) retry = setTimeout(connect, 1000)
        },
        (err) => {
          if (es !== cur) return
          const status = err instanceof ApiError ? err.status : 0
          if (status === 404 || status === 401) {
            dead = true
            opts.onConn(status === 404 ? 'gone' : 'unauthorized')
          } else retry = setTimeout(connect, 3000)
        },
      )
    }
  }

  const onForeground = () => {
    if (!dead && document.visibilityState === 'visible') connect()
  }
  // 切到后台就断开：服务端按概览流连没连着判断手机在不在看，不在才推送（iOS 什么时候掐断连接说不准）
  const onVisibility = () => {
    if (document.visibilityState === 'visible') return onForeground()
    clearTimeout(retry)
    es?.close()
    es = undefined
  }
  document.addEventListener('visibilitychange', onVisibility)
  addEventListener('online', onForeground)
  connect()

  return {
    close() {
      clearTimeout(retry)
      es?.close()
      es = undefined
      document.removeEventListener('visibilitychange', onVisibility)
      removeEventListener('online', onForeground)
    },
  }
}
