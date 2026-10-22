// 开端口：HTTP 一直开（本机脚本、局域网直连都走它）；配了 https 再用自备证书另开一个，手机从那里打开才能用网页推送
import { type Config, expandHome } from './config'

export function listen(hostname: string, config: Config, fetch: (req: Request) => Response | Promise<Response>) {
  // 默认 10 秒会掐断 SSE；255 是上限，另有 20 秒一次的 ping
  const http = Bun.serve({ hostname, port: config.port, fetch, idleTimeout: 255 })
  const tls = config.https
  if (tls) {
    const cert = { cert: Bun.file(expandHome(tls.cert)), key: Bun.file(expandHome(tls.key)) }
    const https = Bun.serve({ hostname, port: tls.port, fetch, idleTimeout: 255, tls: cert })
    console.log(`[cc-remote] HTTPS 端口 ${https.port}，证书 ${tls.cert}`)
  }
  return http
}
