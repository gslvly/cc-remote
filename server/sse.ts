import type { Context } from 'hono'
import { type SSEMessage, streamSSE } from 'hono/streaming'

/**
 * SSE 长连接。setup 里同步地发首条消息并订阅（中间不会漏事件），返回取消订阅。
 * writeSSE 写之前有 await，连着调用不保证顺序，所以这里把写入串起来；另有 20 秒一次的 ping
 */
export function sse(c: Context, setup: (send: (m: SSEMessage) => void) => () => void) {
  return streamSSE(c, async (stream) => {
    let chain = Promise.resolve()
    const enqueue = (write: () => Promise<unknown>) => {
      chain = chain.then(write).then(
        () => {},
        () => {},
      )
    }
    const cleanup = setup((m) => enqueue(() => stream.writeSSE(m)))
    const ping = setInterval(() => enqueue(() => stream.write(': ping\n\n')), 20_000)
    await new Promise<void>((resolve) => stream.onAbort(resolve))
    clearInterval(ping)
    cleanup()
  })
}
