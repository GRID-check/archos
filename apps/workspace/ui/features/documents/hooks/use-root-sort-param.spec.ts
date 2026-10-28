import { renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useRootSortParam } from './use-root-sort-param'

const replace = vi.fn()
let search = new URLSearchParams()
vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace }),
  usePathname: () => '/app/projects/p1/files',
  useSearchParams: () => search,
}))

describe('useRootSortParam', () => {
  beforeEach(() => {
    replace.mockReset()
  })

  it('opens the sort the link names and drops the parameter, keeping the rest of the query', () => {
    search = new URLSearchParams('folder=f1&rootSort=run-1')
    const open = vi.fn()
    renderHook(() => useRootSortParam(true, open))
    expect(open).toHaveBeenCalledOnce()
    expect(replace).toHaveBeenCalledWith('/app/projects/p1/files?folder=f1', { scroll: false })
  })

  it('opens once per run, however often the page renders again', () => {
    search = new URLSearchParams('rootSort=run-1')
    const open = vi.fn()
    const { rerender } = renderHook(() => useRootSortParam(true, open))
    rerender()
    rerender()
    expect(open).toHaveBeenCalledOnce()
  })

  it('does nothing for a reader who may not sort the shelf', () => {
    search = new URLSearchParams('rootSort=run-1')
    const open = vi.fn()
    renderHook(() => useRootSortParam(false, open))
    expect(open).not.toHaveBeenCalled()
    expect(replace).not.toHaveBeenCalled()
  })

  it('waits for the permission to arrive, then opens', () => {
    search = new URLSearchParams('rootSort=run-1')
    const open = vi.fn()
    const { rerender } = renderHook(({ mayOpen }) => useRootSortParam(mayOpen, open), {
      initialProps: { mayOpen: false },
    })
    expect(open).not.toHaveBeenCalled()
    rerender({ mayOpen: true })
    expect(open).toHaveBeenCalledOnce()
  })

  it('does nothing without the parameter', () => {
    search = new URLSearchParams('folder=f1')
    const open = vi.fn()
    renderHook(() => useRootSortParam(true, open))
    expect(open).not.toHaveBeenCalled()
    expect(replace).not.toHaveBeenCalled()
  })
})
