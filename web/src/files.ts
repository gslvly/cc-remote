// 看文件：地址、按扩展名决定怎么预览、二进制判断（取文件在 components/FileSheet.tsx）。服务端见 server/fsRoutes.ts
import type { FileEntry } from '../../shared/protocol'
import { mediaType } from '../../shared/media'

/** 文件本身；v 是修改时间，文件变了换地址，页面里的 img、video 不会用到旧的 */
export const fileUrl = (f: Pick<FileEntry, 'path' | 'mtime'>, download = false) =>
  `/api/fs/file?${new URLSearchParams({ path: f.path, v: String(f.mtime), ...(download ? { dl: '1' } : {}) })}`

export type FileKind = 'image' | 'video' | 'audio' | 'pdf' | 'markdown' | 'text'

/** 服务端按原类型给的（图片、音视频、PDF）浏览器自己显示，其余当文本，二进制的读到才知道 */
export function fileKind(name: string): FileKind {
  const type = mediaType(name)
  if (type === 'application/pdf') return 'pdf'
  if (type) return type.split('/')[0] as 'image' | 'video' | 'audio'
  return /\.(md|markdown|mdx)$/i.test(name) ? 'markdown' : 'text'
}

/** 文本预览只取开头这么多 */
export const PREVIEW_BYTES = 256 * 1024

/** 同 git 的判断：前 8000 字节里有 0 字节就当二进制 */
export const looksBinary = (b: Uint8Array) => b.subarray(0, 8000).includes(0)

/** 分享前要先把文件取下来，太大的不取，只给下载 */
export const SHARE_MAX = 20 * 1024 * 1024

/** 系统分享面板能不能发文件：要 HTTPS，iOS / Android / macOS Safari 有 */
export const canShareFiles = (f: FileEntry) =>
  f.size <= SHARE_MAX &&
  typeof navigator.canShare === 'function' &&
  navigator.canShare({ files: [new File([''], 'a.txt', { type: 'text/plain' })] })
