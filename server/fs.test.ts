// 路径是否在 roots 内：macOS / Linux 和 Windows 的写法都要对
import { describe, expect, test } from 'bun:test'
import { posix, win32 } from 'node:path'
import { inRoots, within } from './fs'

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
