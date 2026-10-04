// 斜杠命令和可选模型：问 claude 子进程（supportedCommands / supportedModels），按目录记着（项目里的 skill 各目录不同）
import { type ModelInfo, query, type Query, type SlashCommand } from '@anthropic-ai/claude-agent-sdk'
import type { Catalog, CatalogCommand } from '../shared/protocol'
import { childEnv, InputQueue } from './child'

/**
 * 列表里有、手机上不该给的。/clear（reset、new）会让子进程换一个会话 id，与这里按 id 管的会话对不上，手机上开新会话用 [+]；
 * focus、fast 在 SDK 里不可用（实测回「not available」）；color、heapdump 是终端外观、调试用的；其余是改名、移除了的和内部用的。
 * 展示类的（/context、/usage、/mcp 等）SDK 会回一段 markdown，照常显示，不用过滤
 */
const HIDDEN = new Set(['clear', 'focus', 'fast', 'color', 'heapdump', 'extra-usage', 'agents', 'workflow-launch-exec'])

/** 发出去会换会话 id 的命令（见 HIDDEN），手打的也要拦 */
export const CLEAR_COMMAND = /^\/(clear|reset|new)(\s|$)/

const commands = (list: SlashCommand[]): CatalogCommand[] =>
  list
    .filter((c) => !HIDDEN.has(c.name) && !c.name.startsWith('_'))
    .map((c) => ({ name: c.name, description: c.description, argumentHint: c.argumentHint || undefined, aliases: c.aliases }))

const models = (list: ModelInfo[]) =>
  list.map((m) => ({
    value: m.value,
    resolved: m.resolvedModel,
    displayName: m.displayName,
    description: m.description,
    efforts: m.supportsEffort ? m.supportedEffortLevels : undefined,
  }))

const cache = new Map<string, Catalog>()
const probing = new Map<string, Promise<Catalog>>()

/** 托管会话的子进程起来后问一次（skill 可能刚加过），记下 */
export async function learnCatalog(cwd: string, q: Query) {
  const [c, m] = await Promise.all([q.supportedCommands(), q.supportedModels()])
  cache.set(cwd, { commands: commands(c), models: models(m) })
}

/** 子进程报的 commands_changed（干活时在子目录里发现了新 skill） */
export function updateCommands(cwd: string, list: SlashCommand[]) {
  const old = cache.get(cwd)
  if (old) cache.set(cwd, { ...old, commands: commands(list) })
}

/** 切模型时状态栏先显示实际的模型 id，不用等下一轮 init */
export const resolveModel = (cwd: string, value: string) => cache.get(cwd)?.models.find((m) => m.value === value)?.resolved

/** 没问过的目录：起一个不落盘、不发消息的子进程问一次（不调模型） */
export function catalog(cwd: string): Promise<Catalog> {
  const hit = cache.get(cwd)
  if (hit) return Promise.resolve(hit)
  let p = probing.get(cwd)
  if (!p) {
    p = probe(cwd).finally(() => probing.delete(cwd))
    probing.set(cwd, p)
  }
  return p
}

async function probe(cwd: string): Promise<Catalog> {
  const input = new InputQueue()
  const q = query({ prompt: input, options: { cwd, env: childEnv(), persistSession: false } })
  try {
    await learnCatalog(cwd, q)
    return cache.get(cwd)!
  } finally {
    input.close()
    q.close()
  }
}
