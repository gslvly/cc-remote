// 常驻：装成 launchd 的用户代理，登录后自动起、退出了自动拉起。日志在 ~/Library/Logs/cc-remote.log
//
//   bun scripts/launchd.ts install     构建前端、写 plist、载入（已载入的先卸下再载入）
//   bun scripts/launchd.ts restart     改了服务端代码后重启（只改前端不用：build 完页面自己会刷新）
//   bun scripts/launchd.ts status      运行状态、最近的日志
//   bun scripts/launchd.ts uninstall   卸下、删 plist（日志留着）
//
// launchd 不读 shell 配置：install 时把当前终端里的 PATH、代理、ANTHROPIC_* 等抄进 plist，这些改了要重新 install
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { PARENT_SESSION_ENV } from '../server/child'

const LABEL = 'com.cc-remote.server'
const REPO = join(import.meta.dir, '..')
const PLIST = join(homedir(), 'Library/LaunchAgents', `${LABEL}.plist`)
const LOG = join(homedir(), 'Library/Logs/cc-remote.log')
const DOMAIN = `gui/${process.getuid!()}`
const SERVICE = `${DOMAIN}/${LABEL}`

/** 抄进 plist 的：找命令、编码、代理、Claude 的认证与设置，以及设了的 CCR_HOST / CCR_PORT */
const KEEP = /^(PATH|SHELL|LANG|LC_\w+|(https?|all|no)_proxy|(ANTHROPIC|CLAUDE|CCR)_\w+)$/i

const die = (msg: string): never => {
  console.error(msg)
  process.exit(1)
}

const launchctl = (...args: string[]) => {
  const r = Bun.spawnSync(['launchctl', ...args])
  return { ok: r.exitCode === 0, out: r.stdout.toString(), err: r.stderr.toString().trim() }
}

function env(): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && KEEP.test(k) && !PARENT_SESSION_ENV.includes(k)) out[k] = v
  return out
}

const xml = (s: string) => `<string>${s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')}</string>`

/** bun 用 PATH 里的那个（升级后路径不变），不用 execPath（解析过符号链接） */
function plist(vars: Record<string, string>) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>${xml(LABEL)}
  <key>ProgramArguments</key>
  <array>${xml(Bun.which('bun') ?? process.execPath)}${xml('server/index.ts')}</array>
  <key>WorkingDirectory</key>${xml(REPO)}
  <key>EnvironmentVariables</key>
  <dict>
${Object.entries(vars)
  .map(([k, v]) => `    <key>${k}</key>${xml(v)}`)
  .join('\n')}
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key>${xml(LOG)}
  <key>StandardErrorPath</key>${xml(LOG)}
</dict>
</plist>
`
}

const logSize = () => (existsSync(LOG) ? statSync(LOG).size : 0)

/** 等服务端打出监听地址（或在等 tailscale），打印这次新写的日志 */
async function showStartup(from: number) {
  let fresh = ''
  for (let i = 0; i < 20 && !/监听|tailscale/.test(fresh); i++) {
    await Bun.sleep(500)
    fresh = readFileSync(LOG).subarray(from).toString()
  }
  console.log(fresh.trim() || '（10 秒内没有日志，用 status 看看）')
}

async function install() {
  if (Bun.spawnSync(['bun', 'run', 'build'], { cwd: REPO, stdout: 'ignore' }).exitCode) die('前端构建失败')
  const vars = env()
  mkdirSync(dirname(PLIST), { recursive: true })
  mkdirSync(dirname(LOG), { recursive: true })
  // 可能带着 API key，只给自己读
  writeFileSync(PLIST, plist(vars), { mode: 0o600 })
  chmodSync(PLIST, 0o600)
  // 已载入的先卸下，新 plist 才生效；等旧的从 launchd 里消失再载入（没消失时 bootstrap 可能报 5: Input/output error）
  if (launchctl('bootout', SERVICE).ok) for (let i = 0; i < 20 && launchctl('print', SERVICE).ok; i++) await Bun.sleep(500)
  const from = logSize()
  const r = launchctl('bootstrap', DOMAIN, PLIST)
  if (!r.ok) die(`载入失败：${r.err}`)
  console.log(`已装好 ${PLIST}\n抄进去的环境变量：${Object.keys(vars).join(' ')}\n日志 ${LOG}\n`)
  await showStartup(from)
}

async function restart() {
  const from = logSize()
  const r = launchctl('kickstart', '-k', SERVICE)
  if (!r.ok) die(`重启失败（装了吗？）：${r.err}`)
  await showStartup(from)
}

function status() {
  const r = launchctl('print', SERVICE)
  if (!r.ok) return console.log(existsSync(PLIST) ? `${PLIST} 在，但没载入` : '没装')
  const lines = r.out.split('\n').filter((l) => /^\t(state|pid|runs|last exit code) =/.test(l))
  console.log(lines.map((l) => l.trim()).join('\n'))
  if (existsSync(LOG)) console.log(`\n${LOG} 最后 15 行：\n${readFileSync(LOG, 'utf8').trimEnd().split('\n').slice(-15).join('\n')}`)
}

function uninstall() {
  launchctl('bootout', SERVICE)
  rmSync(PLIST, { force: true })
  console.log(`已卸下，日志留在 ${LOG}`)
}

const cmd = process.argv[2]
if (cmd === 'install') await install()
else if (cmd === 'restart') await restart()
else if (cmd === 'status') status()
else if (cmd === 'uninstall') uninstall()
else die('用法：bun scripts/launchd.ts install | restart | status | uninstall')
