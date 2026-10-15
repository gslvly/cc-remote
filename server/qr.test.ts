// 登录二维码：地址怎么选、token 放在哪
import { expect, test } from 'bun:test'
import { listenUrls, loginUrl, pickBase } from './qr'

test('听所有网卡时列各网卡地址，否则只列监听的那个', () => {
  expect(listenUrls('0.0.0.0', 8686, ['192.168.1.8', '100.101.7.12'])).toEqual(['http://192.168.1.8:8686', 'http://100.101.7.12:8686'])
  expect(listenUrls('100.101.7.12', 8686, ['192.168.1.8'])).toEqual(['http://100.101.7.12:8686'])
})

test('token 放在 # 后面，不发给服务端', () => {
  expect(loginUrl('https://mac.tail1234.ts.net/', 'abc')).toBe('https://mac.tail1234.ts.net/#/login?token=abc')
})

test('参数优先，其次 publicUrl，最后第一个网卡', () => {
  const urls = ['http://192.168.1.8:8686', 'http://100.101.7.12:8686']
  expect(pickBase('100.101.7.12', 8686, undefined, urls)).toBe('http://100.101.7.12:8686')
  expect(pickBase('https://mac.tail1234.ts.net', 8686, undefined, urls)).toBe('https://mac.tail1234.ts.net')
  expect(pickBase(undefined, 8686, 'https://mac.tail1234.ts.net', urls)).toBe('https://mac.tail1234.ts.net')
  expect(pickBase(undefined, 8686, undefined, urls)).toBe('http://192.168.1.8:8686')
  expect(pickBase(undefined, 8686, undefined, [])).toBeUndefined()
})
