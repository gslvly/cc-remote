// 会话列表里的标题、空会话
import { CWD, Transcript } from './testkit'
import { describe, expect, test } from 'bun:test'
import { appendFileSync } from 'node:fs'
import { join } from 'node:path'
import { getSessionInfo, type SDKSessionInfo } from '@anthropic-ai/claude-agent-sdk'
const { CLAUDE_DIR } = await import('./config')
const { isEmpty, titleOf } = await import('./transcript')

const info = (s: Partial<SDKSessionInfo> & { summary: string }): SDKSessionInfo => ({
  sessionId: '2a8d4f31-cf36-49e7-a22b-1fa6ead1ec92',
  lastModified: 1790339270875,
  ...s,
})

/** CLI 每轮写一行 last-prompt，SDK 的 summary 没标题时取它 */
const lastPrompt = (t: Transcript, text: string) =>
  appendFileSync(
    join(CLAUDE_DIR, 'projects', CWD.replace(/[^a-zA-Z0-9]/g, '-'), `${t.id}.jsonl`),
    JSON.stringify({ type: 'last-prompt', lastPrompt: text, sessionId: t.id }) + '\n',
  )

const image = { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'A'.repeat(200_000) } }

describe('titleOf', () => {
  test('终端里的会话有自动标题，用它', async () => {
    expect(await titleOf(info({ summary: 'Enter 发送', customTitle: 'Enter 发送', firstPrompt: '要求enter 发送，' }))).toBe('Enter 发送')
  })

  test('手机上开的没标题：用第一句，不跟着 summary 变成最后一句', async () => {
    expect(await titleOf(info({ summary: '你是什么模型', firstPrompt: '你在做什么' }))).toBe('你在做什么')
  })

  test('第一句带了大图，SDK 在开头 64KB 里找不到：从文件读出第一句，不用最后一句', async () => {
    const t = new Transcript()
    t.add('user', [image, image, { type: 'text', text: '一个是2024年，一个是2026年\n应该做点什么' }])
    t.reply('看到了')
    t.user('磨玻璃那个最需要注意吗')
    lastPrompt(t, '磨玻璃那个最需要注意吗')
    const meta = (await getSessionInfo(t.id))!
    expect(meta).toMatchObject({ firstPrompt: undefined, summary: '磨玻璃那个最需要注意吗' })
    expect(await titleOf(meta)).toBe('一个是2024年，一个是2026年')
  })

  test('第一句只有图：还没说别的叫「[图片]」，第一句带字的来了用它，之后不再变', async () => {
    const t = new Transcript()
    t.add('user', [image])
    const title = async () => titleOf((await getSessionInfo(t.id))!)
    expect(await title()).toBe('[图片]')
    t.user('这是哪')
    lastPrompt(t, '这是哪')
    expect(await title()).toBe('这是哪')
    t.user('那旁边的呢')
    lastPrompt(t, '那旁边的呢')
    expect(await title()).toBe('这是哪')
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
