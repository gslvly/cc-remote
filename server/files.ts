// 看文件、下载文件的响应头。roots 里的文件谁都可能放（clone 下来的仓库），按原类型在同源下打开的话，
// html / svg 里的脚本能带着登录 cookie 调接口。所以只有图片、音视频、PDF 按原类型给（见 shared/media.ts），
// 其余（包括 html）一律当纯文本，再加 nosniff；除 PDF 外都加 CSP sandbox，直接打开 svg 也不跑脚本
import type { FileEntry } from '../shared/protocol'
import { mediaType } from '../shared/media'

/** 按原类型给的用原类型，其余当 UTF-8 纯文本 */
export const inlineType = (name: string) => mediaType(name) ?? 'text/plain; charset=utf-8'

/** 内容变了（大小或修改时间变了）就换 */
export const etag = (f: FileEntry) => `W/"${f.size.toString(36)}-${f.mtime.toString(36)}"`

/** RFC 6266：filename 给老客户端（非 ASCII 和引号换成 _），filename* 是完整的 UTF-8 名 */
export function disposition(kind: 'inline' | 'attachment', name: string) {
  const ascii = name.replace(/[^\x20-\x7e]|["\\]/g, '_')
  const utf8 = encodeURIComponent(name).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)
  return `${kind}; filename="${ascii}"; filename*=UTF-8''${utf8}`
}

/** download：让浏览器存下来，不显示 */
export function fileHeaders(f: FileEntry, download: boolean): Record<string, string> {
  const type = download ? 'application/octet-stream' : inlineType(f.name)
  return {
    'Content-Type': type,
    'Content-Disposition': disposition(download ? 'attachment' : 'inline', f.name),
    'X-Content-Type-Options': 'nosniff',
    // PDF 不加：Chrome 的 PDF 阅读器在 sandbox 里打不开。PDF 里的脚本跑在阅读器里，碰不到页面
    ...(type === 'application/pdf' ? {} : { 'Content-Security-Policy': 'sandbox' }),
    // 文件会变，每次都问一下；没变就 304
    'Cache-Control': 'private, no-cache',
    ETag: etag(f),
  }
}
