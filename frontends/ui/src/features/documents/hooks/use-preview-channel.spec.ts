/**
 * Closing a preview a link opened. Without `back` the shelf stays, the
 * document's params gone; with one (a search hit's) the reader goes back to
 * the page the link came from, and a `back` outside the app is never followed.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { renderHook } from '@/test-utils'
import type { FileItem } from '../file-types'
import { useDocParamSync } from './use-preview-channel'

const replace = vi.fn()
const push = vi.fn()
const back = vi.fn()
let currentSearch = ''

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push, replace, back, refresh: vi.fn() }),
  usePathname: () => '/app/projects/p1/files',
  useSearchParams: () => new URLSearchParams(currentSearch),
}))

const FILE = { id: 'd1' } as FileItem
const SEARCH = '/app/search?q=REI&view=register'

/** The link has opened d1; then the preview closes. */
function closeAfterLink(search: string): void {
  currentSearch = search
  const { rerender } = renderHook(
    ({ openId }: { openId: string | null }) =>
      useDocParamSync({ openId, files: [FILE], onUrlOpen: vi.fn(), onUrlClose: vi.fn() }),
    { initialProps: { openId: 'd1' as string | null } }
  )
  rerender({ openId: null })
}

afterEach(() => {
  vi.clearAllMocks()
})

describe('closing a linked preview', () => {
  it('returns to the search the link came from', () => {
    closeAfterLink(`doc=d1&page=3&highlight=REI+90&back=${encodeURIComponent(SEARCH)}`)
    expect(replace).toHaveBeenCalledWith(SEARCH, { scroll: false })
  })

  it('stays on the shelf without back, dropping the place', () => {
    closeAfterLink('doc=d1&page=3&highlight=REI+90&folder=f1')
    expect(replace).toHaveBeenCalledWith('/app/projects/p1/files?folder=f1', { scroll: false })
  })

  it('never follows a back outside the app', () => {
    closeAfterLink(`doc=d1&back=${encodeURIComponent('//evil.example/app/search')}`)
    expect(replace).toHaveBeenCalledWith('/app/projects/p1/files', { scroll: false })
  })
})
