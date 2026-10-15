import { describe, expect, it } from 'vitest'
import { act, renderHook } from '@testing-library/react'
import { useDocumentSelection } from './use-document-selection'

describe('useDocumentSelection', () => {
  it('starts off, and starting with a document picks that one', () => {
    const { result } = renderHook(() => useDocumentSelection())
    expect(result.current.active).toBe(false)
    expect(result.current.selectedIds.size).toBe(0)

    act(() => result.current.start('a'))
    expect(result.current.active).toBe(true)
    expect([...result.current.selectedIds]).toEqual(['a'])
  })

  it('is on at zero picks: starting without a document opens an empty selection', () => {
    const { result } = renderHook(() => useDocumentSelection())
    act(() => result.current.start())
    expect(result.current.active).toBe(true)
    expect(result.current.selectedIds.size).toBe(0)
  })

  it('toggles a document in and out', () => {
    const { result } = renderHook(() => useDocumentSelection())
    act(() => result.current.start('a'))
    act(() => result.current.toggle('b'))
    expect([...result.current.selectedIds].sort()).toEqual(['a', 'b'])
    act(() => result.current.toggle('a'))
    expect([...result.current.selectedIds]).toEqual(['b'])
  })

  it('picks exactly the ids it is given', () => {
    const { result } = renderHook(() => useDocumentSelection())
    act(() => result.current.start('a'))
    act(() => result.current.set(['x', 'y', 'z']))
    expect([...result.current.selectedIds]).toEqual(['x', 'y', 'z'])
  })

  it('leaves the mode and forgets the picks', () => {
    const { result } = renderHook(() => useDocumentSelection())
    act(() => result.current.start('a'))
    act(() => result.current.exit())
    expect(result.current.active).toBe(false)
    expect(result.current.selectedIds.size).toBe(0)
  })

  it('keeps its functions stable, so a memoised card is not re-rendered by an unrelated change', () => {
    const { result } = renderHook(() => useDocumentSelection())
    const { toggle, start, exit } = result.current
    act(() => result.current.toggle('a'))
    expect(result.current.toggle).toBe(toggle)
    expect(result.current.start).toBe(start)
    expect(result.current.exit).toBe(exit)
  })
})
