// 路径显示：服务端可能跑在 macOS、Linux 或 Windows 上
import { describe, expect, test } from 'bun:test'
import { basename, crumbs, dirCrumbs, shortPath } from './format'

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

  test('目录页文件的面包屑：从这个目录起', () => {
    const labels = (root: string, path: string) => dirCrumbs(root, path).map((c) => [c.label, c.path])
    expect(labels('/Users/gs/app', '/Users/gs/app')).toEqual([['app', '/Users/gs/app']])
    expect(labels('/Users/gs/app', '/Users/gs/app/web/src')).toEqual([
      ['app', '/Users/gs/app'],
      ['web', '/Users/gs/app/web'],
      ['src', '/Users/gs/app/web/src'],
    ])
    expect(labels('D:\\app', 'D:\\app\\web')).toEqual([
      ['app', 'D:\\app'],
      ['web', 'D:\\app\\web'],
    ])
    // 符号链接进到外面了、前缀相同的兄弟目录
    expect(labels('/Users/gs/app', '/opt/lib')).toEqual([
      ['app', '/Users/gs/app'],
      ['lib', '/opt/lib'],
    ])
    expect(labels('/Users/gs/app', '/Users/gs/app2')).toEqual([
      ['app', '/Users/gs/app'],
      ['app2', '/Users/gs/app2'],
    ])
  })
})
