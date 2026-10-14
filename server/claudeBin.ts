// 子进程用本机装的 claude（终端里那个），不用 SDK 自带的那份。
// 只在两者是同一个文件时才用：SDK 的 manifest.json 列着配套 CLI 各平台的 sha256，本机那份要在里面。
// 对不上（claude 升级了 SDK 没跟上，或反过来）就退回 SDK 自带的；跑 bun run sdk:sync 把 SDK 换成配套的版本。
// 按 stat 缓存，换了文件才重算（230MB 约 0.1 秒）
import { createHash } from 'node:crypto'
import { closeSync, openSync, readFileSync, readSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'

const SDK_DIR = dirname(Bun.resolveSync('@anthropic-ai/claude-agent-sdk', import.meta.dir))

export interface InstalledSdk {
  version: string
  /** 配套的 CLI 版本 */
  cli: string
  /** 配套 CLI 各平台二进制的 sha256 */
  checksums: string[]
}

/** 装着的 SDK。每次现读：sdk-sync 换了 SDK 后要读新的 */
export function installedSdk(): InstalledSdk {
  const pkg = JSON.parse(readFileSync(join(SDK_DIR, 'package.json'), 'utf8')) as { version: string }
  const manifest = JSON.parse(readFileSync(join(SDK_DIR, 'manifest.json'), 'utf8')) as { version: string; platforms: Record<string, { checksum: string }> }
  return { version: pkg.version, cli: manifest.version, checksums: Object.values(manifest.platforms).map((p) => p.checksum) }
}

export function sha256File(path: string): string {
  const hash = createHash('sha256')
  const buf = Buffer.allocUnsafe(8 << 20)
  const fd = openSync(path, 'r')
  try {
    for (let n; (n = readSync(fd, buf)) > 0; ) hash.update(buf.subarray(0, n))
  } finally {
    closeSync(fd)
  }
  return hash.digest('hex')
}

export class LocalClaude {
  private path?: string
  /** 上次核对的文件（dev:ino:size:mtime，读不到是空串）和它是不是配套的 */
  private seen?: { key: string; ok: boolean }

  constructor(private sdk: InstalledSdk = installedSdk()) {}

  /** 配置里写的路径，没写就在 PATH 里找 */
  configure(path = Bun.which('claude') ?? undefined) {
    this.path = path
    this.seen = undefined
  }

  /** 起子进程的选项：本机的与 SDK 配套就用它，否则不传（SDK 用自带的） */
  options(): { pathToClaudeCodeExecutable?: string } {
    return this.matched() ? { pathToClaudeCodeExecutable: this.path } : {}
  }

  /** 启动日志里的一句 */
  describe(): string {
    const sdk = `SDK ${this.sdk.version} 配套的 ${this.sdk.cli}`
    if (!this.path) return `PATH 里没有 claude，用 ${sdk}`
    return this.matched() ? `本机 ${this.path}（与 ${sdk} 是同一个文件）` : `${sdk}（本机 ${this.path} 与它不是同一个文件，跑 bun run sdk:sync 对齐）`
  }

  private matched(): boolean {
    if (!this.path) return false
    let key = ''
    try {
      const s = statSync(this.path)
      key = `${s.dev}:${s.ino}:${s.size}:${s.mtimeMs}`
    } catch {}
    if (this.seen?.key !== key) {
      const ok = key !== '' && this.sdk.checksums.includes(sha256File(this.path))
      // 第一次的结果由启动日志说（describe），之后变了才提醒
      if (this.seen && this.seen.ok !== ok) console.warn(`[claude] 本机 ${this.path} 换了文件，${ok ? '与 SDK 配套，改用它' : `与 SDK ${this.sdk.version} 配套的 ${this.sdk.cli} 不是同一个文件，先用 SDK 自带的；跑 bun run sdk:sync 对齐`}`)
      this.seen = { key, ok }
    }
    return this.seen.ok
  }
}

export const localClaude = new LocalClaude()
