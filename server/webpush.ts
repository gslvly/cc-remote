// 网页推送（Web Push）：PWA 从 HTTPS 打开、允许通知后，提醒由系统直接弹出，点开回到 PWA，不用另装 App。
// 加密按 RFC 8291（aes128gcm），服务端身份按 RFC 8292（VAPID），只用 WebCrypto。
// VAPID 密钥第一次有设备来订阅时生成，和各设备的订阅一起存在 ~/.cc-remote/webpush.json；什么时候推由 Pusher 决定（见 push.ts）
import { generateKeyPairSync, type webcrypto } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import type { WebPushSubscription } from '../shared/protocol'
import type { Notice } from './push'

const { subtle } = crypto
const utf8 = (s: string) => new TextEncoder().encode(s)
export const b64u = (b: Uint8Array) => Buffer.from(b).toString('base64url')
export const unb64u = (s: string) => new Uint8Array(Buffer.from(s, 'base64url'))
const concat = (...parts: Uint8Array[]) => new Uint8Array(Buffer.concat(parts))

/** VAPID 的联系方式。苹果的推送服务不认 localhost、内网地址，用项目主页 */
const SUBJECT = 'https://github.com/gslvly/cc-remote'
/** 手机离线时推送服务替我们存多久 */
const TTL = 24 * 3600

/** WebCrypto 只收底下是 ArrayBuffer 的 */
type Bytes = Uint8Array<ArrayBuffer>

async function hkdf(salt: Bytes, ikm: Bytes, info: Bytes, bytes: number) {
  const key = await subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits'])
  return new Uint8Array(await subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt, info }, key, bytes * 8))
}

/** RFC 8291 加密成单条记录。salt 和本端临时密钥只有测试传（对 RFC 附录 A 的例子） */
export async function encrypt(
  plain: Bytes,
  keys: WebPushSubscription['keys'],
  fixed?: { salt: Bytes; local: CryptoKeyPair },
): Promise<Bytes> {
  const uaPublic = unb64u(keys.p256dh)
  const local = fixed?.local ?? (await subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']))
  const asPublic = new Uint8Array(await subtle.exportKey('raw', local.publicKey))
  const ua = await subtle.importKey('raw', uaPublic, { name: 'ECDH', namedCurve: 'P-256' }, false, [])
  const ecdh = new Uint8Array(await subtle.deriveBits({ name: 'ECDH', public: ua }, local.privateKey, 256))
  const ikm = await hkdf(unb64u(keys.auth), ecdh, concat(utf8('WebPush: info\0'), uaPublic, asPublic), 32)
  const salt = fixed?.salt ?? crypto.getRandomValues(new Uint8Array(16))
  const cek = await subtle.importKey('raw', await hkdf(salt, ikm, utf8('Content-Encoding: aes128gcm\0'), 16), 'AES-GCM', false, ['encrypt'])
  const nonce = await hkdf(salt, ikm, utf8('Content-Encoding: nonce\0'), 12)
  // 明文后面跟 0x02：最后一条记录，不加填充
  const cipher = new Uint8Array(await subtle.encrypt({ name: 'AES-GCM', iv: nonce }, cek, concat(plain, Uint8Array.of(2))))
  // 头：salt(16) ‖ 记录大小(4) ‖ keyid 长度(1) ‖ keyid（本端公钥）
  const header = new Uint8Array(21)
  header.set(salt)
  new DataView(header.buffer).setUint32(16, 4096)
  header[20] = asPublic.length
  return concat(header, asPublic, cipher)
}

/** RFC 8292 的 Authorization 头。WebCrypto 的 ECDSA 签名就是 JWS 要的 r‖s 格式 */
export async function vapidHeader(endpoint: string, publicKey: string, privateKey: CryptoKey, now = Date.now()) {
  const part = (o: object) => b64u(utf8(JSON.stringify(o)))
  const unsigned = `${part({ typ: 'JWT', alg: 'ES256' })}.${part({ aud: new URL(endpoint).origin, exp: Math.floor(now / 1000) + 12 * 3600, sub: SUBJECT })}`
  const sig = await subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, privateKey, utf8(unsigned))
  return `vapid t=${unsigned}.${b64u(new Uint8Array(sig))}, k=${publicKey}`
}

/** 前端传来的订阅：推送地址要是 HTTPS，p256dh 是 P-256 未压缩公钥（65 字节），auth 16 字节 */
export function validSubscription(x: unknown): x is WebPushSubscription {
  const s = x as WebPushSubscription | null
  if (typeof s?.endpoint !== 'string' || typeof s.keys?.p256dh !== 'string' || typeof s.keys.auth !== 'string') return false
  const ua = unb64u(s.keys.p256dh)
  return URL.canParse(s.endpoint) && new URL(s.endpoint).protocol === 'https:' && ua.length === 65 && ua[0] === 4 && unb64u(s.keys.auth).length === 16
}

interface Saved {
  /** 未压缩公钥的 base64url，前端订阅时的 applicationServerKey */
  publicKey: string
  privateKey: webcrypto.JsonWebKey
  subscriptions: WebPushSubscription[]
}

export class WebPush {
  private saved?: Saved
  private signer?: Promise<CryptoKey>

  constructor(private readonly file: string) {}

  /** 读文件；还没有就生成密钥 */
  private get data(): Saved {
    if (this.saved) return this.saved
    if (existsSync(this.file)) return (this.saved = JSON.parse(readFileSync(this.file, 'utf8')) as Saved)
    const jwk = generateKeyPairSync('ec', { namedCurve: 'P-256' }).privateKey.export({ format: 'jwk' })
    this.saved = { publicKey: b64u(concat(Uint8Array.of(4), unb64u(jwk.x!), unb64u(jwk.y!))), privateKey: jwk, subscriptions: [] }
    this.save()
    return this.saved
  }

  private save() {
    writeFileSync(this.file, JSON.stringify(this.saved, null, 2) + '\n', { mode: 0o600 })
  }

  get publicKey() {
    return this.data.publicKey
  }

  /** 订阅了的设备数；没人订阅过就不去生成密钥 */
  get count() {
    return this.saved || existsSync(this.file) ? this.data.subscriptions.length : 0
  }

  /** 同一推送地址只留最新的（换了 keys 就是重新订阅了） */
  add(sub: WebPushSubscription) {
    const d = this.data
    d.subscriptions = [...d.subscriptions.filter((s) => s.endpoint !== sub.endpoint), { endpoint: sub.endpoint, keys: { p256dh: sub.keys.p256dh, auth: sub.keys.auth } }]
    this.save()
  }

  remove(endpoint: string) {
    if (!this.count) return
    const d = this.data
    const left = d.subscriptions.filter((s) => s.endpoint !== endpoint)
    if (left.length === d.subscriptions.length) return
    d.subscriptions = left
    this.save()
  }

  /** 发给每台订阅了的设备的请求；正文是 sw.js 要的 { title, body, session } */
  async requests(n: Notice): Promise<{ url: string; init: RequestInit }[]> {
    if (!this.count) return []
    const { publicKey, privateKey, subscriptions } = this.data
    this.signer ??= subtle.importKey('jwk', privateKey, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign'])
    const key = await this.signer
    const payload = utf8(JSON.stringify({ title: n.title, body: n.body, session: n.session }))
    return Promise.all(
      subscriptions.map(async (s) => ({
        url: s.endpoint,
        init: {
          method: 'POST',
          headers: {
            Authorization: await vapidHeader(s.endpoint, publicKey, key),
            'Content-Encoding': 'aes128gcm',
            'Content-Type': 'application/octet-stream',
            TTL: String(TTL),
            Urgency: n.urgent ? 'high' : 'normal',
          },
          body: await encrypt(payload, s.keys),
        },
      })),
    )
  }
}
