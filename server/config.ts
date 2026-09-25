import { randomBytes } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs'
import { networkInterfaces, homedir } from 'node:os'
import { isAbsolute, join } from 'node:path'

export interface Config {
  token: string
  /** "tailscale" = 自动取本机 100.x 地址；也可以直接写 IP */
  host: string
  port: number
  /** 允许浏览、开会话的目录（含子目录），可以用 ~ 开头 */
  roots: string[]
  /** 同时活着的 claude 子进程上限；到上限时先回收空闲最久的 */
  maxLive: number
  /** 空闲超过这么多分钟就回收子进程，下次发消息时自动 resume */
  idleMinutes: number
  /** 推送到手机，可以两个都配。不配就不推 */
  push?: PushConfig
  /** 推送里深链接的前缀，默认 http://<监听地址>:<端口> */
  publicUrl?: string
}

export interface PushConfig {
  /** server 默认 https://api.day.app；key 是 Bark App 里给的 device key */
  bark?: { server?: string; key: string }
  /** server 默认 https://ntfy.sh：公共服务上谁知道 topic 谁就能订阅，topic 要取得难猜，或者自建。token 是自建服务的访问令牌 */
  ntfy?: { server?: string; topic: string; token?: string }
}

export const CONFIG_DIR = join(homedir(), '.cc-remote')
export const CONFIG_FILE = join(CONFIG_DIR, 'config.json')
/** Claude Code 的数据目录（登记表、transcript），与 CLI 一样认 CLAUDE_CONFIG_DIR */
export const CLAUDE_DIR = process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude')

const DEFAULTS: Omit<Config, 'token'> = { host: 'tailscale', port: 8686, roots: ['~'], maxLive: 6, idleMinutes: 30 }

export function loadConfig(): { config: Config; created: boolean } {
  let saved: Partial<Config> = {}
  if (existsSync(CONFIG_FILE)) saved = JSON.parse(readFileSync(CONFIG_FILE, 'utf8'))

  const created = !saved.token
  const config: Config = { ...DEFAULTS, ...saved, token: saved.token || randomBytes(32).toString('hex') }
  if (created) {
    mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 })
    writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2) + '\n', { mode: 0o600 })
    chmodSync(CONFIG_FILE, 0o600)
  }

  for (const k of ['maxLive', 'idleMinutes'] as const) {
    if (!(config[k] > 0)) throw new Error(`${CONFIG_FILE} 里的 ${k} 要写成正数`)
  }

  if (process.env.CCR_HOST) config.host = process.env.CCR_HOST
  if (process.env.CCR_PORT) config.port = Number(process.env.CCR_PORT)
  // e2e 用：推到本地假的 ntfy
  if (process.env.CCR_PUSH) config.push = JSON.parse(process.env.CCR_PUSH)
  if (config.push?.bark && !config.push.bark.key) throw new Error(`${CONFIG_FILE} 里的 push.bark 要写 key`)
  if (config.push?.ntfy && !config.push.ntfy.topic) throw new Error(`${CONFIG_FILE} 里的 push.ntfy 要写 topic`)
  return { config, created }
}

/**
 * tailscale 的 CGNAT 段 100.64.0.0/10。只看 utun 网卡（macOS 上 VPN 都是 utun）：
 * 有的网络给 Wi-Fi 分的也是这个段，绑到它上面就把服务暴露给局域网了
 */
export function tailscaleIPv4(interfaces = networkInterfaces()): string | undefined {
  for (const [name, addrs] of Object.entries(interfaces)) {
    if (!name.startsWith('utun')) continue
    for (const a of addrs ?? []) {
      if (a.family !== 'IPv4') continue
      const [o1, o2] = a.address.split('.').map(Number)
      if (o1 === 100 && o2! >= 64 && o2! <= 127) return a.address
    }
  }
}

/** 监听地址。"tailscale" 时取本机 100.x 地址，tailscale 还没连上就是 undefined */
export function resolveHost(host: string, find = tailscaleIPv4): string | undefined {
  return host === 'tailscale' ? find() : host
}

/**
 * 等到有监听地址。开机时 tailscale 往往比服务端晚连上，这时退回 127.0.0.1 手机就连不上了，
 * 所以一直等（launchd 下也不退出重来，省得日志里刷屏）
 */
export async function waitForHost(host: string, find = tailscaleIPv4, intervalMs = 2000): Promise<string> {
  let waited = false
  for (;;) {
    const ip = resolveHost(host, find)
    if (ip) {
      if (waited) console.log(`[config] tailscale 连上了：${ip}`)
      return ip
    }
    if (!waited) console.warn('[config] 还没有 tailscale 地址（100.64.0.0/10），等它连上。只在本机用就把 host 写成 127.0.0.1，或设 CCR_HOST=127.0.0.1')
    waited = true
    await Bun.sleep(intervalMs)
  }
}

/** 展开 ~，解析成真实路径（macOS 的 /tmp 实际是 /private/tmp），不存在的跳过 */
export function resolveRoots(roots: string[]): string[] {
  if (!Array.isArray(roots)) throw new Error(`${CONFIG_FILE} 里的 roots 要写成数组`)
  const out: string[] = []
  for (const r of roots) {
    const p = r === '~' || r.startsWith('~/') ? join(homedir(), r.slice(1)) : r
    try {
      if (!isAbsolute(p)) throw new Error('要写绝对路径或 ~ 开头')
      const real = realpathSync(p)
      if (!statSync(real).isDirectory()) throw new Error('不是目录')
      out.push(real)
    } catch (e) {
      console.warn(`[config] roots 里的 ${r} 不可用，已跳过：${e instanceof Error ? e.message : e}`)
    }
  }
  if (!out.length) console.warn('[config] 没有可用的 roots，浏览目录和新建会话都用不了')
  return out
}
