'use client'

import type { JSX } from 'react'
import { useEffect } from 'react'

import { Button } from '@/components/ui/button'
import { Spinner } from '@/components/ui/spinner'
import { useInView } from '@/hooks/use-in-view'
import { cn } from '@/lib/utils'

export interface LoadMoreProps {
  /** Whether a further page exists. */
  hasMore: boolean
  /** A further page is being read. */
  loading: boolean
  /** The last attempt failed: no automatic retry, the button asks again. */
  failed?: boolean
  onLoadMore: () => void
  loadMoreLabel: string
  loadingLabel: string
  failedLabel: string
  /**
   * How far below the viewport the next page is asked for. Ahead of the
   * reader, so a steady scroll does not stop at the end of each page.
   */
  rootMargin?: string
  className?: string
}

/**
 * The end of an infinite list: reaching it reads the next page.
 *
 * A sentinel watched by an `IntersectionObserver` asks for the next page
 * whenever it comes within `rootMargin` of the screen, and again after a page
 * landed if it is still there (a short page, a tall screen). The button is
 * always present while there is more: it is the way on for a keyboard, for an
 * engine without the observer, and after a failed read, which is never retried
 * on its own.
 */
export function LoadMore({
  hasMore,
  loading,
  failed = false,
  onLoadMore,
  loadMoreLabel,
  loadingLabel,
  failedLabel,
  rootMargin = '600px 0px',
  className,
}: LoadMoreProps): JSX.Element | null {
  const [sentinel, inView] = useInView<HTMLDivElement>({ rootMargin })

  useEffect(() => {
    if (inView && hasMore && !loading && !failed) onLoadMore()
  }, [inView, hasMore, loading, failed, onLoadMore])

  if (!hasMore && !loading) return null

  return (
    <div ref={sentinel} className={cn('flex flex-col items-center gap-2 py-4', className)} data-testid="load-more">
      {loading ? (
        <span className="text-muted-foreground inline-flex items-center gap-2 text-xs" role="status">
          <Spinner size="xs" aria-hidden />
          {loadingLabel}
        </span>
      ) : (
        <>
          {failed && <p className="text-muted-foreground text-xs">{failedLabel}</p>}
          <Button type="button" variant="outline" size="sm" onClick={onLoadMore} data-testid="load-more-button">
            {loadMoreLabel}
          </Button>
        </>
      )}
    </div>
  )
}
