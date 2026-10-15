// 登录二维码：手机扫一下直接登录，不用手敲地址和 token。
// 前台启动时 index.ts 打一次；作为后台服务跑时用 `bun run qr [IP 或地址]` 随时出
import { renderUnicodeCompact } from 'uqr'
import { loadConfig, localIPv4s, resolveHost } from './config'

/** 手机能打开的地址：听所有网卡时列出各网卡的 */
export function listenUrls(hostname: string, port: number, ips = localIPv4s()): string[] {
  return (hostname === '0.0.0.0' ? ips : [hostname]).map((ip) => `http://${ip}:${port}`)
}

/** token 放在 # 后面：不发给服务端、进不了访问日志，前端登录时就从地址栏抹掉 */
export function loginUrl(base: string, token: string): string {
  return `${base.replace(/\/+$/, '')}/#/login?token=${token}`
}

/** 二维码用哪个地址：参数是 IP 就补成 http://IP:端口，完整地址原样用；没给就和推送深链接一致（publicUrl 或第一个网卡） */
export function pickBase(arg: string | undefined, port: number, publicUrl: string | undefined, urls: string[]): string | undefined {
  if (arg) return arg.includes('://') ? arg : `http://${arg}:${port}`
  return publicUrl || urls[0]
}

export function printLoginQr(base: string, token: string, urls: string[]) {
  if (/^https?:\/\/(127\.|localhost\b)/.test(base)) {
    console.log('[cc-remote] 只在本机听，手机扫不了码；经 tailscale serve 等转发的话，把 publicUrl 写成手机打开的地址')
    return
  }
  console.log(`[cc-remote] 手机扫码登录 ${base}（码里带着 token，别让人拍到）`)
  console.log(renderUnicodeCompact(loginUrl(base, token), { border: 2 }))
  const others = urls.filter((u) => u !== base)
  if (others.length) console.log(`[cc-remote] 要换地址：bun run qr <IP>，可选 ${others.join('、')}`)
}

if (import.meta.main) {
  const { config } = loadConfig()
  const hostname = resolveHost(config.host)
  const urls = hostname ? listenUrls(hostname, config.port) : []
  const base = pickBase(process.argv[2], config.port, config.publicUrl, urls)
  if (base) printLoginQr(base, config.token, urls)
  else console.log('[cc-remote] host 写的是 tailscale，但它还没连上；连上再试，或 bun run qr <IP>')
}
