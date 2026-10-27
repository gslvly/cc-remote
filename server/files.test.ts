// 看文件：限定在 roots 内、列文件、响应头（类型白名单、下载名、304）
import { afterAll, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import type { FileEntry, FsList } from '../shared/protocol'
import { disposition, fileHeaders, inlineType } from './files'
import { fsRoutes } from './fsRoutes'
import { checkFile, listFiles } from './fs'

const ROOT = realpathSync(mkdtempSync(join(tmpdir(), 'ccr-files-')))
const OUTSIDE = realpathSync(mkdtempSync(join(tmpdir(), 'ccr-outside-')))
const roots = [ROOT]
afterAll(() => {
  rmSync(ROOT, { recursive: true, force: true })
  rmSync(OUTSIDE, { recursive: true, force: true })
})

writeFileSync(join(ROOT, 'b.txt'), 'hello')
writeFileSync(join(ROOT, 'a10.md'), '# 标题')
writeFileSync(join(ROOT, 'a2.html'), '<script>alert(1)</script>')
writeFileSync(join(ROOT, '.env'), 'SECRET=1')
mkdirSync(join(ROOT, 'sub'))
writeFileSync(join(OUTSIDE, 'secret.txt'), 'x')
symlinkSync(join(OUTSIDE, 'secret.txt'), join(ROOT, 'out-link'))
symlinkSync(join(ROOT, 'b.txt'), join(ROOT, 'in-link'))

describe('checkFile', () => {
  test('roots 内的文件：真实路径、大小、修改时间', async () => {
    const f = await checkFile(join(ROOT, 'b.txt'), roots)
    expect(f).toMatchObject({ ok: true, file: { name: 'b.txt', path: join(ROOT, 'b.txt'), size: 5 } })
  })

  test('符号链接：名字是链接的，路径是真实的；指到 roots 外的不给', async () => {
    expect(await checkFile(join(ROOT, 'in-link'), roots)).toMatchObject({ ok: true, file: { name: 'in-link', path: join(ROOT, 'b.txt') } })
    expect(await checkFile(join(ROOT, 'out-link'), roots)).toMatchObject({ ok: false, status: 403 })
  })

  test('相对路径、不存在、目录、roots 外', async () => {
    expect(await checkFile('b.txt', roots)).toMatchObject({ ok: false, status: 400 })
    expect(await checkFile(join(ROOT, 'nope'), roots)).toMatchObject({ ok: false, status: 404 })
    expect(await checkFile(join(ROOT, 'sub'), roots)).toMatchObject({ ok: false, status: 400 })
    expect(await checkFile(join(OUTSIDE, 'secret.txt'), roots)).toMatchObject({ ok: false, status: 403 })
    // 用 .. 绕出去
    expect(await checkFile(`${ROOT}/../${basename(OUTSIDE)}/secret.txt`, roots)).toMatchObject({ ok: false, status: 403 })
  })
})

test('listFiles：按名字（数字按大小）排，不列目录、隐藏文件、指到 roots 外的链接', async () => {
  const names = (fs: FileEntry[]) => fs.map((f) => f.name)
  expect(names(await listFiles(ROOT, roots, false))).toEqual(['a2.html', 'a10.md', 'b.txt', 'in-link'])
  expect(names(await listFiles(ROOT, roots, true))).toEqual(['.env', 'a2.html', 'a10.md', 'b.txt', 'in-link'])
})

describe('响应头', () => {
  test('只有媒体和 PDF 按原类型，html、svg 以外的都当纯文本', () => {
    expect(inlineType('a.PNG')).toBe('image/png')
    expect(inlineType('a.pdf')).toBe('application/pdf')
    expect(inlineType('a.svg')).toBe('image/svg+xml')
    for (const n of ['a.html', 'a.htm', 'a.js', 'a.xhtml', 'Makefile', 'a.constructor', '.png']) {
      expect(inlineType(n)).toBe('text/plain; charset=utf-8')
    }
  })

  test('除 PDF 外都 sandbox；下载时一律 octet-stream', () => {
    const f = (name: string): FileEntry => ({ name, path: `/x/${name}`, size: 1, mtime: 1 })
    expect(fileHeaders(f('a.svg'), false)['Content-Security-Policy']).toBe('sandbox')
    expect(fileHeaders(f('a.html'), false)['Content-Security-Policy']).toBe('sandbox')
    expect(fileHeaders(f('a.pdf'), false)['Content-Security-Policy']).toBeUndefined()
    expect(fileHeaders(f('a.png'), true)).toMatchObject({ 'Content-Type': 'application/octet-stream', 'X-Content-Type-Options': 'nosniff' })
  })

  test('下载名：中文、引号、括号', () => {
    expect(disposition('attachment', 'a.txt')).toBe(`attachment; filename="a.txt"; filename*=UTF-8''a.txt`)
    expect(disposition('inline', '报告 (1)".md')).toBe(
      `inline; filename="__ (1)_.md"; filename*=UTF-8''%E6%8A%A5%E5%91%8A%20%281%29%22.md`,
    )
  })
})

describe('路由', () => {
  const app = fsRoutes(roots, () => false)
  const get = (path: string, init?: RequestInit) => app.request(path, init)
  const q = (p: string, extra = '') => `?path=${encodeURIComponent(p)}${extra}`

  test('/ls 带 files=1 才列文件', async () => {
    const plain = (await (await get(`/ls${q(ROOT)}`)).json()) as FsList
    expect(plain.files).toBeUndefined()
    expect(plain.entries.map((e) => e.name)).toEqual(['sub'])
    const all = (await (await get(`/ls${q(ROOT, '&files=1')}`)).json()) as FsList
    expect(all.files?.map((f) => f.name)).toEqual(['a2.html', 'a10.md', 'b.txt', 'in-link'])
  })

  test('/stat 和 /file：html 当纯文本给；ETag 没变回 304', async () => {
    expect(await (await get(`/stat${q(join(ROOT, 'b.txt'))}`)).json()).toMatchObject({ name: 'b.txt', size: 5 })
    const r = await get(`/file${q(join(ROOT, 'a2.html'))}`)
    expect(r.status).toBe(200)
    expect(r.headers.get('content-type')).toBe('text/plain; charset=utf-8')
    expect(await r.text()).toBe('<script>alert(1)</script>')
    const again = await get(`/file${q(join(ROOT, 'a2.html'))}`, { headers: { 'If-None-Match': r.headers.get('etag')! } })
    expect(again.status).toBe(304)
  })

  test('roots 外、不存在的给 JSON 错误', async () => {
    const out = await get(`/file${q(join(ROOT, 'out-link'))}`)
    expect(out.status).toBe(403)
    expect(await out.json()).toMatchObject({ error: expect.stringContaining('roots') })
    expect((await get(`/stat${q(join(ROOT, 'nope'))}`)).status).toBe(404)
  })
})
