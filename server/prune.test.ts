import { afterAll, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { pruneClaudeVersions, pruneSdkCache, runningIn } from './prune'

const root = realpathSync(mkdtempSync(join(tmpdir(), 'ccr-prune-')))
afterAll(() => rmSync(root, { recursive: true, force: true }))

/** 原生安装的样子：versions 下每版一个文件，bin/claude 链到 current */
function native(name: string, versions: string[], current: string) {
  const dir = join(root, name, 'share/claude/versions')
  mkdirSync(dir, { recursive: true })
  for (const v of versions) writeFileSync(join(dir, v), v)
  const bin = join(root, name, 'bin/claude')
  mkdirSync(dirname(bin), { recursive: true })
  symlinkSync(join(dir, current), bin)
  return { dir, bin }
}

describe('pruneClaudeVersions', () => {
  test('删在用的之前的，在跑的和比它新的留着', () => {
    const { dir, bin } = native('a', ['2.1.285', '2.1.300', '2.1.305', '2.1.307', '2.1.308', 'notes.txt'], '2.1.307')
    expect(pruneClaudeVersions(bin, [join(dir, '2.1.305')])).toEqual({ removed: ['2.1.285', '2.1.300'], kept: ['2.1.305'] })
    expect(readdirSync(dir).sort()).toEqual(['2.1.305', '2.1.307', '2.1.308', 'notes.txt'])
  })

  test('不是原生安装就不动', () => {
    const dir = join(root, 'b/node_modules/.bin')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'claude'), '')
    writeFileSync(join(dir, '2.1.200'), '')
    expect(pruneClaudeVersions(join(dir, 'claude'), [])).toEqual({ removed: [], kept: [] })
    expect(readdirSync(dir).sort()).toEqual(['2.1.200', 'claude'])
  })
})

describe('pruneSdkCache', () => {
  test('只删比装着的旧的 claude-agent-sdk 条目', () => {
    const dir = join(root, 'cache/@anthropic-ai')
    const names = [
      'claude-agent-sdk@0.3.296@@@1',
      'claude-agent-sdk-linux-x64@0.3.296@@@1',
      'claude-agent-sdk-linux-x64-musl@0.3.282@@@1',
      'claude-agent-sdk@0.3.307@@@1',
      'claude-agent-sdk-linux-x64@0.3.307@@@1',
      'claude-agent-sdk-linux-x64@0.3.310@@@1',
      'claude-agent-sdk',
      'sdk@0.128.0@@@1',
    ]
    for (const n of names) mkdirSync(join(dir, n, 'package'), { recursive: true })
    expect(pruneSdkCache(join(root, 'cache'), '0.3.307').sort()).toEqual([
      'claude-agent-sdk-linux-x64-musl@0.3.282@@@1',
      'claude-agent-sdk-linux-x64@0.3.296@@@1',
      'claude-agent-sdk@0.3.296@@@1',
    ])
    expect(readdirSync(dir).sort()).toEqual([
      'claude-agent-sdk',
      'claude-agent-sdk-linux-x64@0.3.307@@@1',
      'claude-agent-sdk-linux-x64@0.3.310@@@1',
      'claude-agent-sdk@0.3.307@@@1',
      'sdk@0.128.0@@@1',
    ])
  })

  test('没有缓存目录就什么都不删', () => {
    expect(pruneSdkCache(join(root, 'nope'), '0.3.307')).toEqual([])
  })
})

test('runningIn 查得到自己', async () => {
  const exe = realpathSync(process.execPath)
  expect(await runningIn(dirname(exe))).toContain(exe)
})
