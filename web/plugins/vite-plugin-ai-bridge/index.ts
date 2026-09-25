import { writeFileSync } from 'fs'
import { resolve } from 'path'
import type { Plugin, ViteDevServer } from 'vite'
import type { IncomingMessage, ServerResponse } from 'http'

/**
 * 让终端在 dev 页面里求值，供 AI 读取应用运行时状态。
 *   curl -s -X POST localhost:$(cat node_modules/.ai-bridge-port)/__ai/exec --data 'document.title'
 * 走 HMR 的 WebSocket 下发，页面应答后原路返回，只在 dev 生效（apply: 'serve'）。
 */

const VIRTUAL_ID = 'virtual:ai-bridge'
const RESOLVED_ID = '\0' + VIRTUAL_ID
const TIMEOUT = 10000
// 8080 被占时 vite 会自动换端口，把实到端口落盘给终端查
const PORT_FILE = resolve(process.cwd(), 'node_modules/.ai-bridge-port')

// 注入页面的客户端。不 import 任何项目模块、不往 window 挂东西、不 patch 全局。
const CLIENT = `
if (import.meta.hot) {
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor

  const serialize = (val) => {
    const seen = new WeakSet()
    return JSON.parse(
      JSON.stringify(val ?? null, (key, v) => {
        if (typeof v === 'function') return '[Function]'
        if (v instanceof Error) return v.name + ': ' + v.message
        if (typeof v === 'object' && v !== null) {
          if (seen.has(v)) return '[Circular]'
          seen.add(v)
        }
        return v
      })
    )
  }

  import.meta.hot.on('ai-bridge:exec', async ({ id, code }) => {
    // 多个标签页都会收到，可见的先答，不可见的让位兜底
    if (document.visibilityState !== 'visible') {
      await new Promise((r) => setTimeout(r, 60))
    }
    let out
    try {
      // 先当表达式，语法不通过再当语句块，行为对齐 devtools 控制台
      let fn
      try {
        fn = new AsyncFunction('return (' + code + ')')
      } catch {
        fn = new AsyncFunction(code)
      }
      out = { ok: serialize(await fn()) }
    } catch (e) {
      out = { err: String(e) }
    }
    import.meta.hot.send('ai-bridge:result', { id, ...out })
  })
}
`

// 输出是给 AI 读的，每个字符都算 token：只给值，不缩进，超长截断
const MAX_OUTPUT = 4000

const reply = (res: ServerResponse, text: string, status = 200) => {
  res.statusCode = status
  res.setHeader('Content-Type', 'text/plain; charset=utf-8')
  res.end(text)
}

const replyResult = (res: ServerResponse, data: { ok?: unknown; err?: string }) => {
  if (data.err !== undefined) return reply(res, `✗ ${data.err}`, 500)
  const s = typeof data.ok === 'string' ? data.ok : String(JSON.stringify(data.ok))
  reply(res, s.length > MAX_OUTPUT ? `${s.slice(0, MAX_OUTPUT)}…（共 ${s.length} 字符，缩小查询范围）` : s)
}

const readBody = (req: IncomingMessage) =>
  new Promise<string>((ok) => {
    let s = ''
    req.on('data', (c) => (s += c))
    req.on('end', () => ok(s))
  })

export const aiBridge = (): Plugin => {
  const pending = new Map<string, ServerResponse>()
  let seq = 0

  return {
    name: 'ai-bridge',
    apply: 'serve',

    resolveId(id) {
      if (id === VIRTUAL_ID) return RESOLVED_ID
    },

    load(id) {
      if (id === RESOLVED_ID) return CLIENT
    },

    transformIndexHtml() {
      return [
        {
          tag: 'script',
          attrs: { type: 'module', src: `/@id/__x00__${VIRTUAL_ID}` },
          injectTo: 'body' as const
        }
      ]
    },

    configureServer(server: ViteDevServer) {
      server.httpServer?.once('listening', () => {
        const addr = server.httpServer?.address()
        if (addr && typeof addr === 'object') {
          try {
            writeFileSync(PORT_FILE, String(addr.port))
          } catch {
            // 落盘失败不影响 dev，终端退化成手填端口
          }
        }
      })

      server.hot.on('ai-bridge:result', (data: { id: string; ok?: unknown; err?: string }) => {
        const res = pending.get(data.id)
        if (!res) return // 已被更快的页面应答，或已超时
        pending.delete(data.id)
        replyResult(res, data)
      })

      server.middlewares.use('/__ai/exec', async (req, res) => {
        // 只给终端用：text/plain 的 POST 不触发预检，任何网页都能跨域打到这里，
        // 而求值的页面带着登录态、能调 /api。浏览器跨域请求必带 Origin，curl 不带
        if (req.headers.origin) return reply(res, '✗ 只接受终端调用', 403)
        if (req.method !== 'POST') return reply(res, '✗ 用 POST，body 直接放 JS 表达式', 405)
        const code = await readBody(req)
        if (!code.trim()) return reply(res, '✗ body 为空', 400)

        const id = String(++seq)
        pending.set(id, res)
        setTimeout(() => {
          if (!pending.delete(id)) return
          reply(res, '✗ 超时：没有页面应答，dev 页面开着吗？', 504)
        }, TIMEOUT)

        server.hot.send('ai-bridge:exec', { id, code })
      })
    }
  }
}
