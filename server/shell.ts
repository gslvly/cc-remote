// 手机上的 ! 命令（终端里的 shell 模式）：在会话目录里跑，输入输出照终端的格式包成用户消息，作为下一轮的上下文交给 Claude
import { childEnv } from './child'

/** 跑多久算超时（同 Bash 工具默认的 2 分钟） */
const TIMEOUT_MS = 120_000
/** stdout、stderr 各留多少字，多的丢掉（同 Bash 工具） */
export const MAX_CHARS = 30_000

export interface ShellOutput {
  stdout: string
  stderr: string
}

/**
 * 用用户的 shell 跑一条命令。自成进程组：超时、中断时连同它起的子进程一起停掉（后台进程占着输出不放也算超时）。
 * 不抛错：起不来、退出码非 0、超时、中断都写进 stderr，Claude 照样看得到
 */
export async function runShell(command: string, cwd: string, signal: AbortSignal, timeout = TIMEOUT_MS): Promise<ShellOutput> {
  let proc: Bun.Subprocess<'ignore', 'pipe', 'pipe'>
  try {
    proc = Bun.spawn([process.env.SHELL || '/bin/sh', '-c', command], {
      cwd,
      env: childEnv(),
      stdin: 'ignore',
      stdout: 'pipe',
      stderr: 'pipe',
      detached: true,
    })
  } catch (e) {
    return { stdout: '', stderr: e instanceof Error ? e.message : String(e) }
  }
  let why = ''
  const stop = (reason: string) => {
    if (why) return
    why = reason
    killGroup(proc.pid, 'SIGTERM')
    setTimeout(() => killGroup(proc.pid, 'SIGKILL'), 2000).unref()
  }
  const timer = setTimeout(() => stop(`Command timed out after ${timeout / 1000}s`), timeout)
  const onAbort = () => stop('Interrupted')
  signal.addEventListener('abort', onAbort)
  if (signal.aborted) onAbort()
  const [stdout, stderr, code] = await Promise.all([collect(proc.stdout), collect(proc.stderr), proc.exited])
  clearTimeout(timer)
  signal.removeEventListener('abort', onAbort)
  const tail = why || (code ? `Exit code ${code}` : '')
  return { stdout, stderr: [stderr, tail].filter(Boolean).join('\n') }
}

/** 照终端的格式包成两条用户消息：命令一条，输出一条 */
export const bashInput = (command: string) => `<bash-input>${command}</bash-input>`
export const bashOutput = (o: ShellOutput) => `<bash-stdout>${o.stdout}</bash-stdout><bash-stderr>${o.stderr}</bash-stderr>`

function killGroup(pid: number, sig: NodeJS.Signals) {
  try {
    process.kill(-pid, sig)
  } catch {
    // 已经都退出了
  }
}

/** 读完一个输出流，只留前 MAX_CHARS 字，去掉末尾的空行 */
async function collect(stream: ReadableStream<Uint8Array>): Promise<string> {
  const dec = new TextDecoder()
  let text = ''
  let cut = false
  for await (const chunk of stream) {
    if (text.length < MAX_CHARS) text += dec.decode(chunk, { stream: true })
    else cut = true
  }
  text += dec.decode()
  if (text.length > MAX_CHARS) {
    text = text.slice(0, MAX_CHARS)
    cut = true
  }
  return cut ? `${text.trimEnd()}\n... [output truncated]` : text.trimEnd()
}
