// 起 claude 子进程要用的：参数、环境变量、流式输入
import type { CanUseTool, EffortLevel, Options, PermissionMode, Query, RewindFilesResult, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk'

/**
 * 没选模式时交给 CLI 按配置定。SDK 不传 permissionMode 会自己补 `--permission-mode default`，
 * 而 CLI 里命令行参数排在配置的 defaultMode 前面，于是 bypassPermissions 永远不生效。
 * resolvePermissionModeInCli 是 SDK 没写进类型的选项（sdk.mjs 里 `permissionMode ?? (resolvePermissionModeInCli ? undefined : 'default')`）
 */
const CLI_DECIDES_MODE: {} = { resolvePermissionModeInCli: true }

/**
 * 托管会话起子进程的参数。mode、model、effort 是手机上选过、切过的，子进程回收后 resume 也接着用；
 * 没有就由 CLI 按配置定（模式看配置里的 defaultMode）
 */
export interface SpawnArgs {
  id: string
  cwd: string
  /** 起过子进程了：resume，否则用这个 id 新建 */
  resume: boolean
  /** 回退过：对话只接到这条（含）为止，见 Session.rewind */
  resumeAt?: string
  mode?: PermissionMode
  model?: string
  effort?: EffortLevel
  canUseTool: CanUseTool
}

export function spawnOptions(o: SpawnArgs): Options {
  return {
    cwd: o.cwd,
    // 第一次用预生成的 id 新建；子进程回收或退出后再发消息，就 resume 接着聊（不会重放旧消息）
    ...(o.resume ? { resume: o.id } : { sessionId: o.id }),
    ...(o.resume && o.resumeAt && { resumeSessionAt: o.resumeAt }),
    // 每条用户消息前给要改的文件留底，回退时用 rewindFiles 还原（快照记在 transcript 里，resume 后还在）
    enableFileCheckpointing: true,
    env: childEnv(),
    // 不传时 SDK 发的是空系统提示词，与终端不一致
    systemPrompt: { type: 'preset', preset: 'claude_code' },
    ...(o.mode ? { permissionMode: o.mode } : CLI_DECIDES_MODE),
    ...(o.model && { model: o.model }),
    ...(o.effort && { effort: o.effort }),
    // 不带的话配置里的 defaultMode: bypassPermissions 会被 CLI 忽略、退回 default
    allowDangerouslySkipPermissions: true,
    // 逐字蹦出：增量由 LiveTracker 合并，不进缓冲
    includePartialMessages: true,
    canUseTool: o.canUseTool,
    stderr: (s) => console.error(`[claude ${o.id.slice(0, 8)}] ${s.trimEnd()}`),
  }
}

/**
 * 文件还原成发 uuid 那条用户消息时的样子，dryRun 只预览。
 * 这条没留底（开检查点之前发的、本地命令）时预览报 canRewind: false，真还原则直接报错，所以先预览
 */
export async function rewindFiles(q: Query, uuid: string, dryRun: boolean): Promise<RewindFilesResult> {
  const preview = await q.rewindFiles(uuid, { dryRun: true })
  return dryRun || !preview.canRewind ? preview : q.rewindFiles(uuid)
}

/**
 * 从某个 Claude Code 终端里启动服务端时会继承这些「父会话」标记，
 * 子进程会误以为自己是那个终端的子会话，所以去掉。
 * 入口标记也去掉，交给 SDK 设为 sdk-ts：设成 cli 也会被 CLI 在无头模式下改写成 sdk-cli（见 REFERENCE.md）。
 */
export const PARENT_SESSION_ENV = [
  'CLAUDE_CODE_ENTRYPOINT',
  'CLAUDECODE',
  'CLAUDE_CODE_SESSION_ID',
  'CLAUDE_CODE_CHILD_SESSION',
  'CLAUDE_CODE_SESSION_ATTENDED',
  'CLAUDE_CODE_MESSAGING_SOCKET',
  'CLAUDE_CODE_MESSAGING_TOKEN',
  'CLAUDE_CODE_EXECPATH',
  'CLAUDE_CODE_SSE_PORT',
  'CLAUDE_PID',
  'CLAUDE_EFFORT',
]

export function childEnv(): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = { ...process.env }
  for (const k of PARENT_SESSION_ENV) delete env[k]
  env.CLAUDE_AGENT_SDK_CLIENT_APP = 'cc-remote/0.1.0'
  return env
}

/** 流式输入：进程常驻，push 一条就是一轮输入 */
export class InputQueue implements AsyncIterable<SDKUserMessage> {
  private items: SDKUserMessage[] = []
  private wake?: () => void
  private closed = false

  push(msg: SDKUserMessage) {
    this.items.push(msg)
    this.wake?.()
  }

  close() {
    this.closed = true
    this.wake?.()
  }

  async *[Symbol.asyncIterator]() {
    while (true) {
      const next = this.items.shift()
      if (next) yield next
      else if (this.closed) return
      else await new Promise<void>((r) => (this.wake = r))
    }
  }
}
