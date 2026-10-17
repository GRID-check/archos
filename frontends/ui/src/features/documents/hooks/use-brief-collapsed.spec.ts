import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { act, renderHook } from '@testing-library/react'
import { useBriefCollapsed } from './use-brief-collapsed'

const KEY = 'grid.files.brief.collapsed'

describe('useBriefCollapsed', () => {
  beforeEach(() => window.localStorage.clear())
  afterEach(() => window.localStorage.clear())

  it('is folded by default', () => {
    const { result } = renderHook(() => useBriefCollapsed())
    expect(result.current[0]).toBe(true)
  })

  it('on a desk, opens the card the reader left open', () => {
    window.localStorage.setItem(KEY, '0')
    const { result } = renderHook(() => useBriefCollapsed(false))
    expect(result.current[0]).toBe(false)
  })

  it('on a phone, stays folded whatever the desk chose', () => {
    window.localStorage.setItem(KEY, '0')
    const { result } = renderHook(() => useBriefCollapsed(true))
    expect(result.current[0]).toBe(true)
  })

  it('folds again when the screen becomes a phone after it opened', () => {
    window.localStorage.setItem(KEY, '0')
    const { result, rerender } = renderHook(({ phone }) => useBriefCollapsed(phone), {
      initialProps: { phone: false },
    })
    expect(result.current[0]).toBe(false)
    rerender({ phone: true })
    expect(result.current[0]).toBe(true)
  })

  it('remembers a choice made on a desk, and does not remember one made on a phone', () => {
    const desk = renderHook(() => useBriefCollapsed(false))
    act(() => desk.result.current[1](false))
    expect(window.localStorage.getItem(KEY)).toBe('0')
    desk.unmount()

    window.localStorage.setItem(KEY, '1')
    const phone = renderHook(() => useBriefCollapsed(true))
    act(() => phone.result.current[1](false))
    expect(phone.result.current[0]).toBe(false)
    expect(window.localStorage.getItem(KEY)).toBe('1')
  })
})
