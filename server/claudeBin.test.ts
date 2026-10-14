import { afterAll, describe, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { LocalClaude, sha256File } from './claudeBin'

const DIR = mkdtempSync(join(tmpdir(), 'ccr-claude-'))
const BIN = join(DIR, 'claude')
const sha = (s: string) => createHash('sha256').update(s).digest('hex')
afterAll(() => rmSync(DIR, { recursive: true, force: true }))

function local(...contents: string[]) {
  const c = new LocalClaude({ version: '0.3.1', cli: '2.1.1', checksums: contents.map(sha) })
  c.configure(BIN)
  return c
}

describe('LocalClaude', () => {
  test('sha256File 与一次性算的一致', () => {
    writeFileSync(BIN, 'x'.repeat(9 << 20))
    expect(sha256File(BIN)).toBe(sha('x'.repeat(9 << 20)))
  })

  test('与 SDK 配套的才用，否则交给 SDK 自带的', () => {
    writeFileSync(BIN, 'official')
    expect(local('official').options()).toEqual({ pathToClaudeCodeExecutable: BIN })
    expect(local('other').options()).toEqual({})
  })

  test('换了文件重新核对', () => {
    writeFileSync(BIN, 'official')
    const c = local('official')
    expect(c.options().pathToClaudeCodeExecutable).toBe(BIN)
    // 大小也不同：有的文件系统 inode 会马上复用，mtime 也可能落在同一毫秒
    rmSync(BIN)
    writeFileSync(BIN, 'upgraded build')
    expect(c.options()).toEqual({})
    rmSync(BIN)
    expect(c.options()).toEqual({})
  })

  test('没找到本机的', () => {
    const c = new LocalClaude({ version: '0.3.1', cli: '2.1.1', checksums: [] })
    expect(c.options()).toEqual({})
    expect(c.describe()).toContain('PATH 里没有 claude')
  })
})
