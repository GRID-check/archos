import type { JSX } from 'react'
import { Skeleton } from '@/components/ui/skeleton'

/**
 * What a reading has not delivered yet, drawn as the sections it will become:
 * a heading and a connected list of rows, the shape of „Prüfen". It is the
 * page's one ambient loop while Piloti reads (the status line only shows
 * progress), and nothing in it carries a word: the status line already says
 * what is going on.
 */
export function ReadingSkeleton(): JSX.Element {
  return (
    <div className="space-y-3" aria-hidden="true" data-testid="intake-reading-skeleton">
      <Skeleton className="h-6 w-40" />
      <div className="bg-card divide-y overflow-hidden rounded-lg border">
        {[0, 1, 2].map((row) => (
          <div key={row} className="flex items-start gap-3 px-4 py-3">
            <div className="min-w-0 flex-1 space-y-2">
              <Skeleton className="h-3 w-1/3" />
              <Skeleton className="h-4 w-1/2" />
              <Skeleton className="h-5 w-2/3" />
            </div>
            <Skeleton className="hidden h-8 w-24 sm:block" />
          </div>
        ))}
      </div>
    </div>
  )
}

/**
 * Where the reading's summary will stand once Piloti has finished, drawn as
 * its lines: the Erfassung step's one ambient loop while it reads. Wordless
 * for the same reason as {@link ReadingSkeleton}; the step says in words that
 * the summary follows.
 */
export function ReadingSummarySkeleton(): JSX.Element {
  return (
    <div className="space-y-2" aria-hidden="true" data-testid="intake-reading-skeleton">
      <Skeleton className="h-4 w-full" />
      <Skeleton className="h-4 w-11/12" />
      <Skeleton className="h-4 w-2/3" />
    </div>
  )
}
