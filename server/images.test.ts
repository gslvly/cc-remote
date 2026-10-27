// 看图：按 key（消息 uuid / 工具调用 id）从 transcript 里取第 n 张
import { CWD, Transcript } from './testkit'
import { describe, expect, test } from 'bun:test'
const { findImage, rememberSent } = await import('./images')

const image = (data: string, media_type = 'image/png') => ({ type: 'image', source: { type: 'base64', media_type, data } })

describe('findImage', () => {
  test('人发的图按消息 uuid 取，Read 读的图按工具调用 id 取；张数越界、别的行里提到 key 的都不算', async () => {
    const t = new Transcript()
    const sent = t.add('user', [{ type: 'text', text: '看图' }, image('AAAA'), image('BBBB', 'image/jpeg')])
    t.add('assistant', [{ type: 'tool_use', id: 'toolu_1', name: 'Read', input: { file_path: '/a.png' } }])
    t.add('user', [{ type: 'tool_result', tool_use_id: 'toolu_1', content: [image('CCCC')] }])
    const s = { sessionId: t.id, cwd: CWD }

    expect(await findImage(s, sent, 0)).toEqual({ mediaType: 'image/png', data: 'AAAA' })
    expect(await findImage(s, sent, 1)).toEqual({ mediaType: 'image/jpeg', data: 'BBBB' })
    expect(await findImage(s, sent, 2)).toBeUndefined()
    expect(await findImage(s, 'toolu_1', 0)).toEqual({ mediaType: 'image/png', data: 'CCCC' })
    expect(await findImage(s, 'toolu_2', 0)).toBeUndefined()
  })

  test('不是图片类型的不给（防着拿它当网页回给浏览器）', async () => {
    const t = new Transcript()
    const uuid = t.add('user', [image('PHN2Zz4=', 'text/html')])
    expect(await findImage({ sessionId: t.id, cwd: CWD }, uuid, 0)).toBeUndefined()
  })

  test('刚发的还没写进 transcript：从内存里取', async () => {
    const t = new Transcript()
    const uuid = crypto.randomUUID()
    rememberSent(uuid, [{ mediaType: 'image/webp', data: 'DDDD' }])
    expect(await findImage({ sessionId: t.id, cwd: CWD }, uuid, 0)).toEqual({ mediaType: 'image/webp', data: 'DDDD' })
  })
})
