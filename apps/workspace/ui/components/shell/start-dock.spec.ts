import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, renderHook } from '@testing-library/react'

import { DOCK_LAYOUT_QUERY } from '@/hooks/use-is-mobile'
import { START_DOCK_WIDTH_MAX, START_DOCK_WIDTH_MIN, useStartDock, useStartDockDoor, useStartDockShown } from './start-dock'

/** Whether the window has room for a docked panel. */
let roomy = true
const realMatchMedia = window.matchMedia

beforeEach(() => {
  roomy = true
  window.matchMedia = ((query: string) => ({
    matches: query === DOCK_LAYOUT_QUERY ? roomy : false,
    media: query,
    addEventListener: () => {},
    removeEventListener: () => {},
  })) as unknown as typeof window.matchMedia
  window.sessionStorage.clear()
  window.localStorage.clear()
  useStartDock.setState({ panel: null })
})
afterEach(() => {
  window.matchMedia = realMatchMedia
})

const click = (overrides: Partial<{ button: number; metaKey: boolean; ctrlKey: boolean; shiftKey: boolean; altKey: boolean }> = {}) => ({
  defaultPrevented: false,
  button: 0,
  metaKey: false,
  ctrlKey: false,
  shiftKey: false,
  altKey: false,
  preventDefault: vi.fn(),
  ...overrides,
})

describe('the start dock', () => {
  it('opens, closes and toggles one panel, and this tab remembers it across a reload', () => {
    useStartDock.getState().toggle('inbox')
    expect(useStartDock.getState().panel).toBe('inbox')
    useStartDock.setState({ panel: null })
    useStartDock.getState().restore()
    expect(useStartDock.getState().panel).toBe('inbox')
    useStartDock.getState().toggle('inbox')
    expect(useStartDock.getState().panel).toBeNull()
    useStartDock.getState().restore()
    expect(useStartDock.getState().panel).toBeNull()
  })

  it('keeps the reader’s width on this device, within its bounds', () => {
    useStartDock.getState().setWidth(10)
    expect(useStartDock.getState().width).toBe(START_DOCK_WIDTH_MIN)
    useStartDock.getState().setWidth(5000)
    expect(useStartDock.getState().restoreWidth()).toBe(START_DOCK_WIDTH_MAX)
  })

  it('forgets nothing it cannot store, and fails nobody: storage refusing is not an error', () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('blocked')
    })
    expect(() => useStartDock.getState().open('inbox')).not.toThrow()
    expect(useStartDock.getState().panel).toBe('inbox')
    vi.restoreAllMocks()
  })
})

describe('a door to the dock', () => {
  it('where it fits, a plain click opens the panel instead of following the link', () => {
    const { result } = renderHook(() => useStartDockDoor('inbox'))
    const event = click()
    act(() => result.current.onClick(event))
    expect(event.preventDefault).toHaveBeenCalled()
    expect(useStartDock.getState().panel).toBe('inbox')
  })

  it('a new tab, a modified click or a window without room follows the link as it always did', () => {
    const { result, rerender } = renderHook(() => useStartDockDoor('inbox'))
    const modified = click({ metaKey: true })
    act(() => result.current.onClick(modified))
    expect(modified.preventDefault).not.toHaveBeenCalled()
    roomy = false
    rerender()
    const narrow = click()
    act(() => result.current.onClick(narrow))
    expect(narrow.preventDefault).not.toHaveBeenCalled()
    expect(useStartDock.getState().panel).toBeNull()
  })

  it('a panel counts as docked only while there is room for it', () => {
    useStartDock.getState().open('inbox')
    const { result, rerender } = renderHook(() => useStartDockShown())
    expect(result.current).toBe(true)
    roomy = false
    rerender()
    expect(result.current).toBe(false)
  })
})
