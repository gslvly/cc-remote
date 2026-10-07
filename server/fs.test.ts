// 路径是否在 roots 内：macOS / Linux 和 Windows 的写法都要对；新建、删除文件夹的限制
import { afterAll, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, posix, win32 } from 'node:path'
import { inRoots, makeDir, removeDir, within } from './fs'

const ROOT = realpathSync(mkdtempSync(join(tmpdir(), 'ccr-fs-')))
const roots = [ROOT]
const idle = () => false
afterAll(() => rmSync(ROOT, { recursive: true, force: true }))

describe('makeDir', () => {
  test('建一层，名字去掉首尾空白', async () => {
    expect(await makeDir(ROOT, '  新项目 ', roots)).toEqual({ ok: true, path: join(ROOT, '新项目') })
    expect(existsSync(join(ROOT, '新项目'))).toBe(true)
  })

  test('同名已存在不覆盖', async () => {
    writeFileSync(join(ROOT, 'a.txt'), '')
    expect(await makeDir(ROOT, 'a.txt', roots)).toMatchObject({ ok: false, status: 409 })
  })

  test('名字不能为空、带分隔符、是 . 或 ..', async () => {
    for (const name of ['', '  ', '.', '..', 'a/b', '../x', 'a\\b', 1]) {
      expect(await makeDir(ROOT, name, roots)).toMatchObject({ ok: false, status: 400 })
    }
    expect(existsSync(join(ROOT, 'a'))).toBe(false)
  })

  test('parent 要在 roots 内', async () => {
    expect(await makeDir(tmpdir(), 'x', roots)).toMatchObject({ ok: false, status: 403 })
  })
})

describe('removeDir', () => {
  test('连同里面的东西一起删', async () => {
    const dir = join(ROOT, 'del')
    mkdirSync(join(dir, 'sub'), { recursive: true })
    writeFileSync(join(dir, 'sub', 'f.txt'), 'x')
    expect(await removeDir(dir, roots, idle)).toEqual({ ok: true, path: dir })
    expect(existsSync(dir)).toBe(false)
  })

  test('root 本身、包含 root 的目录不删', async () => {
    const inner = join(ROOT, 'inner')
    mkdirSync(inner)
    expect(await removeDir(ROOT, roots, idle)).toMatchObject({ ok: false, status: 403 })
    expect(await removeDir(ROOT, [ROOT, inner], idle)).toMatchObject({ ok: false, status: 403 })
    expect(await removeDir(inner, [ROOT, inner], idle)).toMatchObject({ ok: false, status: 403 })
    expect(existsSync(inner)).toBe(true)
  })

  test('符号链接不删，链接指向的目录也不动', async () => {
    const target = join(ROOT, 'target')
    mkdirSync(target)
    symlinkSync(target, join(ROOT, 'link'))
    expect(await removeDir(join(ROOT, 'link'), roots, idle)).toMatchObject({ ok: false, status: 400 })
    expect(existsSync(target)).toBe(true)
  })

  test('有会话在跑不删', async () => {
    const dir = join(ROOT, 'busy')
    mkdirSync(dir)
    expect(await removeDir(dir, roots, (d) => d === dir)).toMatchObject({ ok: false, status: 409 })
    expect(existsSync(dir)).toBe(true)
  })

  test('不存在、不在 roots 内', async () => {
    expect(await removeDir(join(ROOT, 'nope'), roots, idle)).toMatchObject({ ok: false, status: 404 })
    expect(await removeDir(tmpdir(), roots, idle)).toMatchObject({ ok: false, status: 403 })
  })
})

describe('within', () => {
  test('/ 分隔', () => {
    expect(within('/Users/gs/code', '/Users/gs', posix)).toBe(true)
    expect(within('/Users/gs', '/Users/gs', posix)).toBe(true)
    // 前缀相同的兄弟目录不算
    expect(within('/Users/gs2', '/Users/gs', posix)).toBe(false)
    expect(within('/Users', '/Users/gs', posix)).toBe(false)
    // 名字以 .. 开头的子目录算
    expect(within('/Users/gs/..cache', '/Users/gs', posix)).toBe(true)
    expect(within('/etc', '/', posix)).toBe(true)
  })

  test('Windows：\\ 分隔、盘符不分大小写、不同盘不算', () => {
    expect(within('C:\\Users\\gs\\code', 'C:\\Users\\gs', win32)).toBe(true)
    expect(within('c:\\users\\gs\\code', 'C:\\Users\\gs', win32)).toBe(true)
    expect(within('C:\\Users\\gs2', 'C:\\Users\\gs', win32)).toBe(false)
    expect(within('D:\\Users\\gs', 'C:\\Users\\gs', win32)).toBe(false)
    expect(within('D:\\code', 'C:\\', win32)).toBe(false)
    expect(within('C:\\code', 'C:\\', win32)).toBe(true)
  })

  test('inRoots：任一 root 包含就行', () => {
    expect(inRoots('D:\\work\\app', ['C:\\Users\\gs', 'D:\\work'], win32)).toBe(true)
    expect(inRoots('D:\\other', ['C:\\Users\\gs', 'D:\\work'], win32)).toBe(false)
    expect(inRoots('/srv/app', ['/home/gs', '/srv'], posix)).toBe(true)
  })
})
