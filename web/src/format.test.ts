// 路径显示：服务端可能跑在 macOS、Linux 或 Windows 上
import { describe, expect, test } from 'bun:test'
import { basename, crumbs, shortPath } from './format'

describe('路径显示', () => {
  test('basename', () => {
    expect(basename('/Users/gs/code/app')).toBe('app')
    expect(basename('/Users/gs/code/app/')).toBe('app')
    expect(basename('/')).toBe('/')
    expect(basename('C:\\Users\\gs\\code\\app')).toBe('app')
    expect(basename('\\\\nas\\share\\app')).toBe('app')
  })

  test('家目录缩写成 ~，太长只留后几段', () => {
    expect(shortPath('/Users/gs/code/app')).toBe('~/code/app')
    expect(shortPath('/home/gs/code/app')).toBe('~/code/app')
    expect(shortPath('C:\\Users\\gs\\code\\app')).toBe('~\\code\\app')
    expect(shortPath('/Users/gs/a/b/c/d', 3)).toBe('…/b/c/d')
    expect(shortPath('D:\\a\\b\\c\\d', 3)).toBe('…\\b\\c\\d')
  })

  test('面包屑', () => {
    const labels = (roots: string[], path: string) => crumbs({ roots, path, entries: [] }).map((c) => [c.label, c.path])
    expect(labels(['/Users/gs'], '/Users/gs/code/app')).toEqual([
      ['~', '/Users/gs'],
      ['code', '/Users/gs/code'],
      ['app', '/Users/gs/code/app'],
    ])
    expect(labels(['/'], '/etc')).toEqual([
      ['/', '/'],
      ['etc', '/etc'],
    ])
    expect(labels(['C:\\Users\\gs', 'D:\\'], 'D:\\work\\app')).toEqual([
      ['全部', null],
      ['D:\\', 'D:\\'],
      ['work', 'D:\\work'],
      ['app', 'D:\\work\\app'],
    ])
    // 前缀相同的兄弟目录不算在 root 里
    expect(labels(['C:\\Users\\gs'], 'C:\\Users\\gs2')).toEqual([['C:\\Users\\gs2', 'C:\\Users\\gs2']])
  })
})
