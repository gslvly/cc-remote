// 审批的决定怎么回给 SDK；权限模式、模型、effort 的切换与记忆
import { CWD, idle, spawned, Transcript } from './testkit'
import { describe, expect, test } from 'bun:test'
import type { PermissionUpdate } from '@anthropic-ai/claude-agent-sdk'
import type { PermissionRequest } from '../shared/protocol'

const { Session } = await import('./session')
const { permissionResult } = await import('./permission')
const { catalog, CLEAR_COMMAND } = await import('./catalog')

const rule: PermissionUpdate = { type: 'addRules', rules: [{ toolName: 'Bash', ruleContent: 'npm test' }], behavior: 'allow', destination: 'localSettings' }
const req = (o: Partial<PermissionRequest> = {}): PermissionRequest => ({ id: 'r', toolName: 'Bash', input: { command: 'npm test' }, ...o })

describe('permissionResult', () => {
  test('允许：input 用原件；本会话都允许把建议规则改成只对本会话生效', () => {
    const input = { command: 'npm test' }
    expect(permissionResult({ req: req({ suggestions: [rule] }), input }, { behavior: 'allow' })).toEqual({ behavior: 'allow', updatedInput: input })
    expect(permissionResult({ req: req({ suggestions: [rule] }), input }, { behavior: 'allow', always: true })).toEqual({
      behavior: 'allow',
      updatedInput: input,
      updatedPermissions: [{ ...rule, destination: 'session' }],
    })
    // CLI 说了不要提供「总是允许」
    const r = permissionResult({ req: req({ suggestions: [rule], suppressAlwaysAllowRule: true }), input }, { behavior: 'allow', always: true })
    expect(r).toEqual({ behavior: 'allow', updatedInput: input })
  })

  test('AskUserQuestion 的回答并进 input；ExitPlanMode 批准时切模式', () => {
    const input = { questions: [{ question: 'Q?', header: 'h', options: [], multiSelect: true }] }
    const r = permissionResult(
      { req: req({ toolName: 'AskUserQuestion', input: {} }), input },
      { behavior: 'allow', answers: { 'Q?': 'a, b' }, annotations: { 'Q?': { notes: 'n' } } },
    )
    expect(r).toEqual({ behavior: 'allow', updatedInput: { ...input, answers: { 'Q?': 'a, b' }, annotations: { 'Q?': { notes: 'n' } } } })
    expect(permissionResult({ req: req({ toolName: 'ExitPlanMode' }), input: { plan: 'p' } }, { behavior: 'allow', mode: 'acceptEdits' })).toEqual({
      behavior: 'allow',
      updatedInput: { plan: 'p' },
      updatedPermissions: [{ type: 'setMode', mode: 'acceptEdits', destination: 'session' }],
    })
  })

  test('拒绝：附了话就转给 Claude 接着跑，没附就停下这一轮', () => {
    const said = permissionResult({ req: req(), input: {} }, { behavior: 'deny', message: ' 用 bun test ' })
    expect(said.behavior === 'deny' && said.interrupt).toBeFalsy()
    expect(said.behavior === 'deny' && said.message.endsWith('the user said:\n用 bun test')).toBe(true)
    const stop = permissionResult({ req: req(), input: {} }, { behavior: 'deny', message: '  ' })
    expect(stop).toMatchObject({ behavior: 'deny', interrupt: true })
  })
})

describe('Session 的审批与权限模式', () => {
  const fresh = () => new Session(new Transcript().id, CWD, 't', () => {}, { fresh: true })
  const signal = new AbortController().signal

  test('审批：等批准时 requires_action，手机上的决定回给 canUseTool', async () => {
    const s = fresh()
    s.send('one')
    await idle(s)
    const { options } = spawned.at(-1)!
    const result = options.canUseTool!('Bash', { command: 'npm test' }, { signal, suggestions: [rule], toolUseID: 'tu', requestId: 'req1' })
    expect(s.state).toBe('requires_action')
    expect(s.hello().events.at(-1)?.ev).toMatchObject({ type: 'permission_request', req: { id: 'req1', suggestions: [rule] } })
    expect(s.decide('req1', { behavior: 'allow', always: true })).toBe(true)
    expect(await result).toMatchObject({ behavior: 'allow', updatedPermissions: [{ destination: 'session' }] })
    expect(s.state).toBe('idle')
    expect(s.decide('req1', { behavior: 'allow' })).toBe(false)
  })

  test('没选模式就不传，并让 SDK 别补 default，由 CLI 按配置定', async () => {
    const s = fresh()
    s.send('one')
    await idle(s)
    const { options } = spawned.at(-1)!
    expect(options.permissionMode).toBeUndefined()
    expect(options).toMatchObject({ resolvePermissionModeInCli: true, allowDangerouslySkipPermissions: true })
  })

  test('新建时选的模式带给子进程；中途切的调 setPermissionMode；回收后 resume 接着用', async () => {
    const s = fresh()
    s.permissionMode = 'plan'
    s.send('one')
    await idle(s)
    const first = spawned.at(-1)!
    expect(first.options.permissionMode).toBe('plan')

    await s.setMode('acceptEdits')
    expect(first.modes).toEqual(['acceptEdits'])
    expect(s.info().permissionMode).toBe('acceptEdits')

    s.sleep()
    await s.setMode('plan')
    expect(first.modes).toEqual(['acceptEdits'])
    s.send('two')
    await idle(s)
    const second = spawned.at(-1)!
    expect(second).not.toBe(first)
    expect(second.options).toMatchObject({ resume: s.id, permissionMode: 'plan' })
  })
})

describe('切模型、effort，命令列表', () => {
  const fresh = () => new Session(new Transcript().id, CWD, 't', () => {}, { fresh: true })

  test('活着时调 setModel / applyFlagSettings，状态栏先换成实际的模型；回收后 resume 带上', async () => {
    const s = fresh()
    s.send('one')
    await idle(s)
    await Bun.sleep(1) // 命令、模型列表是起来后另外问的
    const first = spawned.at(-1)!
    await s.setModel({ model: 'sonnet', effort: 'low' })
    expect(first.models).toEqual(['sonnet'])
    expect(first.flags).toEqual([{ effortLevel: 'low' }])
    expect(s.info()).toMatchObject({ model: 'claude-sonnet-5', effort: 'low' })

    s.sleep()
    s.send('two')
    await idle(s)
    expect(spawned.at(-1)!.options).toMatchObject({ resume: s.id, model: 'sonnet', effort: 'low' })

    // effort 回到默认：之后起子进程不再带
    await s.setModel({ effort: null })
    s.sleep()
    s.send('three')
    await idle(s)
    expect(spawned.at(-1)!.options.effort).toBeUndefined()
  })

  test('命令列表滤掉 /clear 这类；手打的 /clear 也认得出来', async () => {
    const s = fresh()
    s.send('one')
    await idle(s)
    await Bun.sleep(1)
    const { commands, models } = await catalog(CWD)
    expect(commands.map((c) => c.name)).toEqual(['compact', 'usage', 'my-skill'])
    expect(models[0]).toMatchObject({ value: 'sonnet', resolved: 'claude-sonnet-5', efforts: ['low', 'high'] })
    expect(models[1]!.efforts).toBeUndefined()
    for (const t of ['/clear', '/new', '/reset 名字']) expect(CLEAR_COMMAND.test(t)).toBe(true)
    for (const t of ['/clearly', 'clear', '/compact']) expect(CLEAR_COMMAND.test(t)).toBe(false)
  })
})
