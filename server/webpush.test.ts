// 网页推送：加密对 RFC 8291 附录 A 的例子，VAPID 签名能验，订阅表的增删，经 Pusher 发出去的请求能解开
import { afterAll, afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { SDKResultMessage } from '@anthropic-ai/claude-agent-sdk'
import { pusher } from './push'
import { b64u, encrypt, unb64u, validSubscription, vapidHeader, WebPush } from './webpush'

const { subtle } = crypto
const utf8 = (s: string) => new TextEncoder().encode(s)

/** RFC 8291 附录 A 的输入，result 是第 5 节的整条报文（base64url 里的空白已去掉） */
const RFC = {
  plain: 'V2hlbiBJIGdyb3cgdXAsIEkgd2FudCB0byBiZSBhIHdhdGVybWVsb24',
  asPublic: 'BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8',
  asPrivate: 'yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw',
  uaPublic: 'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4',
  uaPrivate: 'q1dXpw3UpT5VOmu_cf_v6ih07Aems3njxI-JWgLcM94',
  salt: 'DGv6ra1nlYgDCS1FRnbzlw',
  auth: 'BTBZMqHH6r4Tts7J_aSIgg',
  result:
    'DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPT' +
    'pK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN',
}
const keys = { p256dh: RFC.uaPublic, auth: RFC.auth }

/** 未压缩公钥 + d 拼成 JWK（WebCrypto 不收裸的 EC 私钥） */
const jwk = (pub: string, d: string) => {
  const p = unb64u(pub)
  return { kty: 'EC', crv: 'P-256', x: b64u(p.slice(1, 33)), y: b64u(p.slice(33)), d }
}
const ecdhPair = async (pub: string, d: string): Promise<CryptoKeyPair> => ({
  publicKey: await subtle.importKey('raw', unb64u(pub), { name: 'ECDH', namedCurve: 'P-256' }, true, []),
  privateKey: await subtle.importKey('jwk', jwk(pub, d), { name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']),
})

/** 收件方（浏览器）那一侧：用 ua 私钥解开 */
async function decrypt(body: Uint8Array<ArrayBuffer>) {
  const hkdf = async (salt: Uint8Array<ArrayBuffer>, ikm: Uint8Array<ArrayBuffer>, info: Uint8Array<ArrayBuffer>, n: number) =>
    new Uint8Array(await subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt, info }, await subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits']), n * 8))
  const salt = body.slice(0, 16)
  const asPublic = body.slice(21, 21 + body[20]!)
  const ua = await ecdhPair(RFC.uaPublic, RFC.uaPrivate)
  const as = await subtle.importKey('raw', asPublic, { name: 'ECDH', namedCurve: 'P-256' }, false, [])
  const ecdh = new Uint8Array(await subtle.deriveBits({ name: 'ECDH', public: as }, ua.privateKey, 256))
  const info = new Uint8Array([...utf8('WebPush: info\0'), ...unb64u(RFC.uaPublic), ...asPublic])
  const ikm = await hkdf(unb64u(RFC.auth), ecdh, info, 32)
  const cek = await subtle.importKey('raw', await hkdf(salt, ikm, utf8('Content-Encoding: aes128gcm\0'), 16), 'AES-GCM', false, ['decrypt'])
  const nonce = await hkdf(salt, ikm, utf8('Content-Encoding: nonce\0'), 12)
  const plain = new Uint8Array(await subtle.decrypt({ name: 'AES-GCM', iv: nonce }, cek, body.slice(21 + asPublic.length)))
  expect(plain.at(-1)).toBe(2)
  return new TextDecoder().decode(plain.slice(0, -1))
}

const dir = mkdtempSync(join(tmpdir(), 'ccr-webpush-'))
afterAll(() => rmSync(dir, { recursive: true, force: true }))
let n = 0
const store = () => new WebPush(join(dir, `webpush-${++n}.json`))
const sub = (endpoint: string) => ({ endpoint, keys })

describe('加密与签名', () => {
  test('RFC 8291 附录 A 的例子，逐字节一致', async () => {
    const out = await encrypt(unb64u(RFC.plain), keys, { salt: unb64u(RFC.salt), local: await ecdhPair(RFC.asPublic, RFC.asPrivate) })
    expect(b64u(out)).toBe(RFC.result)
  })

  test('随机 salt、临时密钥时收件方能解开', async () => {
    expect(await decrypt(await encrypt(utf8('待批准 · 你好'), keys))).toBe('待批准 · 你好')
  })

  test('VAPID：aud 是推送服务的 origin，签名用公钥能验', async () => {
    const pair = await subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify'])
    const pub = b64u(new Uint8Array(await subtle.exportKey('raw', pair.publicKey)))
    const now = Date.parse('2026-10-03T00:00:00Z')
    const h = await vapidHeader('https://web.push.apple.com/QGx3b2xk', pub, pair.privateKey, now)
    const [, t, k] = h.match(/^vapid t=([\w-]+\.[\w-]+\.[\w-]+), k=([\w-]+)$/)!
    expect(k).toBe(pub)
    const [head, claims, sig] = t!.split('.')
    expect(JSON.parse(Buffer.from(claims!, 'base64url').toString())).toEqual({
      aud: 'https://web.push.apple.com',
      exp: now / 1000 + 12 * 3600,
      sub: 'https://github.com/gslvly/cc-remote',
    })
    expect(await subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, pair.publicKey, unb64u(sig!), utf8(`${head}.${claims}`))).toBe(true)
  })
})

describe('订阅表', () => {
  test('只收 HTTPS 推送地址和合法的 P-256 公钥', () => {
    expect(validSubscription(sub('https://fcm.googleapis.com/fcm/send/abc'))).toBe(true)
    expect(validSubscription(sub('http://127.0.0.1:1/x'))).toBe(false)
    expect(validSubscription({ endpoint: 'https://a.b/x', keys: { p256dh: RFC.auth, auth: RFC.auth } })).toBe(false)
    expect(validSubscription({ endpoint: 'https://a.b/x' })).toBe(false)
    expect(validSubscription(null)).toBe(false)
  })

  test('没人订阅过不生成密钥；同一地址只留一份；删了写回文件', () => {
    const w = store()
    expect(w.count).toBe(0)
    expect(existsSync(join(dir, `webpush-${n}.json`))).toBe(false)
    const key = w.publicKey
    expect(unb64u(key).length).toBe(65)
    w.add(sub('https://a.example/1'))
    w.add(sub('https://a.example/1'))
    w.add(sub('https://a.example/2'))
    w.remove('https://a.example/1')
    const again = new WebPush(join(dir, `webpush-${n}.json`))
    expect([again.publicKey, again.count]).toEqual([key, 1])
  })
})

describe('经 Pusher 发出去', () => {
  let sent: { url: string; init: RequestInit }[]
  let status: number
  let web: WebPush
  beforeEach(() => {
    sent = []
    status = 201
    web = store()
    web.add(sub('https://web.push.apple.com/dev1'))
    pusher.configure(undefined, 'http://100.101.102.103:8686', web)
    spyOn(globalThis, 'fetch').mockImplementation((async (url: string, init: RequestInit) => {
      sent.push({ url, init })
      return new Response('', { status })
    }) as unknown as typeof fetch)
  })
  afterEach(() => (globalThis.fetch as unknown as { mockRestore(): void }).mockRestore())
  afterAll(() => pusher.configure(undefined, ''))

  const settle = () => new Promise((r) => setTimeout(r, 50))
  const s = { id: 'b3f1c2d4-5e6f-4a7b-8c9d-0e1f2a3b4c5d', title: '加网页推送' }
  const bash = { id: 'r1', toolName: 'Bash', input: { command: 'date > stamp.txt' } }

  test('待批准：高优先级，正文解开是 sw.js 要的 JSON', async () => {
    pusher.approval(s, bash)
    await settle()
    expect(sent.length).toBe(1)
    const { url, init } = sent[0]!
    const h = init.headers as Record<string, string>
    expect(url).toBe('https://web.push.apple.com/dev1')
    expect([h['Content-Encoding'], h.Urgency, h.TTL]).toEqual(['aes128gcm', 'high', '86400'])
    expect(h.Authorization).toStartWith(`vapid t=`)
    expect(h.Authorization).toEndWith(`, k=${web.publicKey}`)
    expect(JSON.parse(await decrypt(init.body as Uint8Array<ArrayBuffer>))).toEqual({ title: '待批准 · 加网页推送', body: 'Bash：date > stamp.txt', session: s.id })
  })

  test('一轮结束是普通优先级；概览流连着就不推', async () => {
    const unview = pusher.view()
    pusher.done(s, { type: 'result', subtype: 'success', is_error: false, result: 'ok' } as SDKResultMessage)
    unview()
    pusher.done(s, { type: 'result', subtype: 'success', is_error: false, result: 'ok' } as SDKResultMessage)
    await settle()
    expect(sent.map((r) => (r.init.headers as Record<string, string>).Urgency)).toEqual(['normal'])
  })

  test('推送服务回 410（设备退订了）就删掉订阅', async () => {
    status = 410
    pusher.approval(s, bash)
    await settle()
    expect(web.count).toBe(0)
  })
})
