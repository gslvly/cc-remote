// 发图片前的缩放：按比例缩到长边 1568，小图不放大
import { describe, expect, test } from 'bun:test'
import { fitSize } from './image'

describe('fitSize', () => {
  test('长边超了：按比例缩到 1568', () => {
    expect(fitSize(1170, 2532)).toEqual({ w: 725, h: 1568 })
    expect(fitSize(4032, 3024)).toEqual({ w: 1568, h: 1176 })
  })

  test('没超的原样，不放大', () => {
    expect(fitSize(800, 600)).toEqual({ w: 800, h: 600 })
    expect(fitSize(1568, 1000)).toEqual({ w: 1568, h: 1000 })
    expect(fitSize(1, 1)).toEqual({ w: 1, h: 1 })
  })

  test('极细长的图短边至少 1 像素', () => {
    expect(fitSize(20000, 5)).toEqual({ w: 1568, h: 1 })
  })
})
