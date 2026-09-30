// 监听地址：所有网卡时列出可访问的地址；host 写 tailscale 时的识别、开机时等它连上
import { describe, expect, test } from 'bun:test'
import type { NetworkInterfaceInfo } from 'node:os'
import { localIPv4s, tailscaleIPv4, waitForHost } from './config'

const v4 = (address: string, internal = false): NetworkInterfaceInfo => ({ address, family: 'IPv4', netmask: '255.255.255.255', mac: '00:00:00:00:00:00', internal, cidr: null })

test('所有网卡的地址：跳过回环、IPv6、链路本地', () => {
  const v6: NetworkInterfaceInfo = { address: 'fe80::1', family: 'IPv6', netmask: 'ffff::', mac: '00:00:00:00:00:00', internal: false, cidr: null, scopeid: 0 }
  expect(localIPv4s({ lo0: [v4('127.0.0.1', true)], en0: [v6, v4('192.168.1.8')], en5: [v4('169.254.105.30')], utun4: [v4('100.101.7.12')] })).toEqual(['192.168.1.8', '100.101.7.12'])
})

describe('tailscale 地址', () => {
  test('只认 tailscale 网卡上的 100.64.0.0/10', () => {
    expect(tailscaleIPv4({ en0: [v4('192.168.1.8')], utun4: [v4('100.101.7.12')] })).toBe('100.101.7.12')
    // Linux、Windows 上的网卡名
    expect(tailscaleIPv4({ eth0: [v4('192.168.1.8')], tailscale0: [v4('100.101.7.12')] })).toBe('100.101.7.12')
    expect(tailscaleIPv4({ 'Wi-Fi': [v4('192.168.1.8')], Tailscale: [v4('100.101.7.12')] })).toBe('100.101.7.12')
    // Wi-Fi 分到同一段的不算
    expect(tailscaleIPv4({ en0: [v4('100.72.3.4')] })).toBeUndefined()
    // 100.128 起不在这个段
    expect(tailscaleIPv4({ utun4: [v4('100.128.0.1')] })).toBeUndefined()
  })

  test('还没连上就等，连上了返回它的地址；写死的 host 直接用', async () => {
    let calls = 0
    const find = () => (++calls < 3 ? undefined : '100.101.7.12')
    expect(await waitForHost('tailscale', find, 1)).toBe('100.101.7.12')
    expect(calls).toBe(3)
    expect(await waitForHost('127.0.0.1', () => undefined, 1)).toBe('127.0.0.1')
  })
})
