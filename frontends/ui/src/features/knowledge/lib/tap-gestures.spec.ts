import { describe, expect, it } from 'vitest'
import { DOUBLE_TAP_MS, TAP_MAX_MS, classifyTap, type TapRecord } from './tap-gestures'

const press = (overrides: Partial<TapRecord> = {}): TapRecord => ({
  time: 1000,
  x: 100,
  y: 100,
  fingers: 1,
  moved: false,
  ...overrides,
})

describe('classifyTap', () => {
  it('a short press that did not travel is a tap', () => {
    expect(classifyTap(press(), null, 1100).kind).toBe('single')
  })

  it('a press that travelled was a scroll, and one held long was a hold', () => {
    expect(classifyTap(press({ moved: true }), null, 1100).kind).toBe('none')
    expect(classifyTap(press(), null, 1000 + TAP_MAX_MS + 1).kind).toBe('none')
  })

  it('a second tap close by, soon after the first, is a double tap', () => {
    const first = press({ time: 900 })
    expect(classifyTap(press({ time: 900 + DOUBLE_TAP_MS - 10, x: 110 }), first, 1300).kind).toBe(
      'double'
    )
  })

  it('too late or too far, it is a new single tap', () => {
    const first = press({ time: 500 })
    expect(classifyTap(press({ time: 500 + DOUBLE_TAP_MS + 1 }), first, 900).kind).toBe('single')
    expect(classifyTap(press({ time: 600, x: 200 }), first, 700).kind).toBe('single')
  })

  it('two fingers down and up together is a two-finger tap, three is nothing', () => {
    expect(classifyTap(press({ fingers: 2 }), null, 1100).kind).toBe('two-finger')
    expect(classifyTap(press({ fingers: 3 }), null, 1100).kind).toBe('none')
  })
})
