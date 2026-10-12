/**
 * The end of an infinite list (ADR-0102): reaching it reads the next page,
 * once per arrival, never after a failure on its own, and the button is the
 * way on for a keyboard and for an engine without the observer.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@/test-utils'
import { installLayoutObservers } from '@/test-utils/layout-observers'
import { LoadMore } from './load-more'

const LABELS = { loadMoreLabel: 'Load more', loadingLabel: 'Loading more…', failedLabel: 'Could not load more.' }

let restore: (() => void) | null = null
afterEach(() => {
  restore?.()
  restore = null
})

describe('LoadMore', () => {
  it('asks for the next page when the end of the list comes into view', () => {
    restore = installLayoutObservers({ intersecting: true })
    const onLoadMore = vi.fn()
    render(<LoadMore hasMore loading={false} onLoadMore={onLoadMore} {...LABELS} />)
    expect(onLoadMore).toHaveBeenCalledTimes(1)
  })

  it('does not ask again while a page is being read', () => {
    restore = installLayoutObservers({ intersecting: true })
    const onLoadMore = vi.fn()
    render(<LoadMore hasMore loading onLoadMore={onLoadMore} {...LABELS} />)
    expect(onLoadMore).not.toHaveBeenCalled()
    expect(screen.getByText('Loading more…')).toBeInTheDocument()
  })

  it('does not retry a failed page on its own, and says it failed', () => {
    restore = installLayoutObservers({ intersecting: true })
    const onLoadMore = vi.fn()
    render(<LoadMore hasMore loading={false} failed onLoadMore={onLoadMore} {...LABELS} />)
    expect(onLoadMore).not.toHaveBeenCalled()
    expect(screen.getByText('Could not load more.')).toBeInTheDocument()
    fireEvent.click(screen.getByTestId('load-more-button'))
    expect(onLoadMore).toHaveBeenCalledTimes(1)
  })

  it('offers the button where nothing reports the scroll position', () => {
    const onLoadMore = vi.fn()
    render(<LoadMore hasMore loading={false} onLoadMore={onLoadMore} {...LABELS} />)
    expect(onLoadMore).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Load more' }))
    expect(onLoadMore).toHaveBeenCalledTimes(1)
  })

  it('draws nothing once the list is complete', () => {
    render(<LoadMore hasMore={false} loading={false} onLoadMore={vi.fn()} {...LABELS} />)
    expect(screen.queryByTestId('load-more')).not.toBeInTheDocument()
  })
})
