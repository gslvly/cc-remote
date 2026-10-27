// 看文件：按扩展名决定怎么预览、二进制判断、大小显示
import { describe, expect, test } from 'bun:test'
import { fileKind, fileUrl, looksBinary } from './files'
import { bytes } from './format'

describe('看文件', () => {
  test('按扩展名决定怎么预览，其余当文本', () => {
    expect(fileKind('a.PNG')).toBe('image')
    expect(fileKind('a.svg')).toBe('image')
    expect(fileKind('a.mov')).toBe('video')
    expect(fileKind('a.m4a')).toBe('audio')
    expect(fileKind('a.pdf')).toBe('pdf')
    expect(fileKind('README.md')).toBe('markdown')
    for (const n of ['a.ts', 'a.html', 'Makefile', '.png', 'a.constructor']) expect(fileKind(n)).toBe('text')
  })

  test('地址带修改时间，下载加 dl', () => {
    expect(fileUrl({ path: '/a b/报告.md', mtime: 5 })).toBe('/api/fs/file?path=%2Fa+b%2F%E6%8A%A5%E5%91%8A.md&v=5')
    expect(fileUrl({ path: '/a', mtime: 5 }, true)).toBe('/api/fs/file?path=%2Fa&v=5&dl=1')
  })

  test('前 8000 字节里有 0 字节就当二进制', () => {
    expect(looksBinary(new TextEncoder().encode('普通文本\n'))).toBe(false)
    expect(looksBinary(new Uint8Array([0x89, 0x50, 0x00, 0x47]))).toBe(true)
    const late = new Uint8Array(9000).fill(0x61)
    late[8500] = 0
    expect(looksBinary(late)).toBe(false)
  })

  test('大小', () => {
    expect(bytes(0)).toBe('0 B')
    expect(bytes(1023)).toBe('1023 B')
    expect(bytes(1536)).toBe('1.5 KB')
    expect(bytes(12 * 1024 * 1024)).toBe('12 MB')
    expect(bytes(3 * 1024 ** 3)).toBe('3.0 GB')
  })
})
