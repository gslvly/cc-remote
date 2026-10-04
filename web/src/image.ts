// 随消息发的图片。长边超过 MAX_EDGE、体积超过上限、或格式 API 不认的，才用 canvas 按比例缩小并转 JPEG；
// 其余原样发，小图不放大
import type { ImageAttachment } from '../../shared/protocol'

/** 长边超过它 API 也会缩，在手机上先缩好能少传一些 */
const MAX_EDGE = 1568
/** base64 之后不超过 5MB（API 单张的上限） */
const MAX_BYTES = (5 * 1024 * 1024 * 3) / 4
const TYPES = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp'])

/** 按比例缩到长边不超过 max；本来就不超过的原样返回 */
export function fitSize(w: number, h: number, max = MAX_EDGE) {
  const k = Math.min(1, max / Math.max(w, h))
  return { w: Math.max(1, Math.round(w * k)), h: Math.max(1, Math.round(h * k)) }
}

export interface PickedImage extends ImageAttachment {
  /** 预览用的 data URL */
  url: string
}

export async function prepareImage(file: Blob): Promise<PickedImage> {
  const src = URL.createObjectURL(file)
  try {
    const img = new Image()
    img.src = src
    await img.decode().catch(() => {
      throw new Error('读不了这张图片')
    })
    const { naturalWidth: w0, naturalHeight: h0 } = img
    const { w, h } = fitSize(w0, h0)
    if (w === w0 && h === h0 && file.size <= MAX_BYTES && TYPES.has(file.type)) return attach(file)
    const canvas = document.createElement('canvas')
    canvas.width = w
    canvas.height = h
    const ctx = canvas.getContext('2d')!
    // JPEG 没有透明，透明的地方不垫底色会变黑
    ctx.fillStyle = '#fff'
    ctx.fillRect(0, 0, w, h)
    ctx.drawImage(img, 0, 0, w, h)
    const blob = await new Promise<Blob | null>((r) => canvas.toBlob(r, 'image/jpeg', 0.85))
    if (!blob) throw new Error('压缩图片失败')
    return attach(blob)
  } finally {
    URL.revokeObjectURL(src)
  }
}

async function attach(blob: Blob): Promise<PickedImage> {
  const url = await new Promise<string>((resolve, reject) => {
    const r = new FileReader()
    r.onload = () => resolve(r.result as string)
    r.onerror = () => reject(r.error)
    r.readAsDataURL(blob)
  })
  return { mediaType: blob.type as ImageAttachment['mediaType'], data: url.slice(url.indexOf(',') + 1), url }
}
