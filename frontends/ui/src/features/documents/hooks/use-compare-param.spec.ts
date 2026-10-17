import { renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { FileItem } from '../file-types'
import { useCompareParam } from './use-compare-param'

const replace = vi.fn()
let search = new URLSearchParams()
vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace }),
  usePathname: () => '/app/projects/p1/files',
  useSearchParams: () => search,
}))

const openFassungCompare = vi.fn()
vi.mock('../components/fassung-compare', () => ({
  useFassungCompare: () => ({ openFassungCompare, compareElement: null }),
}))

const row = (id: string, filename: string): FileItem =>
  ({
    id,
    filename,
    displayName: null,
    status: 'ready',
    folderId: null,
    createdAt: '2026-01-01T00:00:00Z',
  }) as FileItem

const NEWER = row('doc-b', 'Grundriss EG Index C.pdf')
const OLDER = row('doc-a', 'Grundriss EG Index B.pdf')

describe('useCompareParam', () => {
  beforeEach(() => {
    replace.mockReset()
    openFassungCompare.mockReset()
  })

  it('opens the comparison the link asks for, older against newer, and drops the parameter', () => {
    search = new URLSearchParams('doc=doc-b&compare=doc-a&folder=f1')
    renderHook(() => useCompareParam([NEWER, OLDER]))
    expect(openFassungCompare).toHaveBeenCalledWith(
      { id: 'doc-a', filename: 'Grundriss EG Index B.pdf' },
      { id: 'doc-b', filename: 'Grundriss EG Index C.pdf' }
    )
    // `?doc=` and everything else stay; a reload must not reopen the comparison.
    expect(replace).toHaveBeenCalledWith('/app/projects/p1/files?doc=doc-b&folder=f1', {
      scroll: false,
    })
  })

  it('waits for the rows, then opens once', () => {
    search = new URLSearchParams('doc=doc-b&compare=doc-a')
    const { rerender } = renderHook(({ files }) => useCompareParam(files), {
      initialProps: { files: [] as FileItem[] },
    })
    expect(openFassungCompare).not.toHaveBeenCalled()
    expect(replace).not.toHaveBeenCalled()
    rerender({ files: [NEWER, OLDER] })
    rerender({ files: [NEWER, OLDER] })
    expect(openFassungCompare).toHaveBeenCalledTimes(1)
  })

  it('drops the parameter without opening anything when the older document is not in the listing', () => {
    search = new URLSearchParams('doc=doc-b&compare=doc-gone')
    renderHook(() => useCompareParam([NEWER]))
    expect(openFassungCompare).not.toHaveBeenCalled()
    expect(replace).toHaveBeenCalledWith('/app/projects/p1/files?doc=doc-b', { scroll: false })
  })

  it('waits for the rest of the listing before concluding the older document is missing', () => {
    // The listing streams in page by page; the older Fassung is usually further
    // down it than the newer one.
    search = new URLSearchParams('doc=doc-b&compare=doc-a')
    const { rerender } = renderHook(({ files, complete }) => useCompareParam(files, complete), {
      initialProps: { files: [NEWER] as FileItem[], complete: false },
    })
    expect(replace).not.toHaveBeenCalled()
    rerender({ files: [NEWER, OLDER], complete: true })
    expect(openFassungCompare).toHaveBeenCalledTimes(1)
    expect(replace).toHaveBeenCalledWith('/app/projects/p1/files?doc=doc-b', { scroll: false })
  })

  it('does nothing without the parameter', () => {
    search = new URLSearchParams('doc=doc-b')
    renderHook(() => useCompareParam([NEWER, OLDER]))
    expect(openFassungCompare).not.toHaveBeenCalled()
    expect(replace).not.toHaveBeenCalled()
  })
})
