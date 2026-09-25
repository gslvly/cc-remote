// 会话列表里的标题、空会话
import { describe, expect, test } from 'bun:test'
import type { SDKSessionInfo } from '@anthropic-ai/claude-agent-sdk'
import { isEmpty, titleOf } from './transcript'

const info = (s: Partial<SDKSessionInfo> & { summary: string }): SDKSessionInfo => ({
  sessionId: '2a8d4f31-cf36-49e7-a22b-1fa6ead1ec92',
  lastModified: 1790339270875,
  ...s,
})

describe('titleOf', () => {
  test('终端里的会话有自动标题，用它', () => {
    expect(titleOf(info({ summary: 'Enter 发送', customTitle: 'Enter 发送', firstPrompt: '要求enter 发送，' }))).toBe('Enter 发送')
  })

  test('手机上开的没标题：用第一句，不跟着 summary 变成最后一句', () => {
    expect(titleOf(info({ summary: '你是什么模型', firstPrompt: '你在做什么' }))).toBe('你在做什么')
  })
})

describe('isEmpty', () => {
  test('/clear 之后什么都没做的算空', () => {
    expect(isEmpty(info({ summary: '/clear', firstPrompt: '/clear' }))).toBe(true)
  })

  test('/clear 之后接着聊了的不算', () => {
    expect(isEmpty(info({ summary: 'History session titles', customTitle: 'History session titles', firstPrompt: '历史会话不是session的标题吗？' }))).toBe(false)
  })
})
