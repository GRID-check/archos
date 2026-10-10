'use client'

/**
 * The changes beside the sheet: one group per page, one row per box, Piloti's
 * sentence under its box's label when the two can be paired. It is the same
 * list as the boxes on the sheet, not a second account of them: hovering a row
 * lights its box, clicking it shows the box (turning the page and scrolling to
 * it), and a box clicked on the sheet lights its row here.
 */

import type { JSX, ReactNode } from 'react'
import { useEffect, useRef } from 'react'
import { RotateCw } from 'lucide-react'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { SectionLabel } from '@/components/ui/section-label'
import { Skeleton } from '@/components/ui/skeleton'
import { useTranslations } from '@/i18n'
import { cn } from '@/lib/utils'
import { ChangeBadge } from './compare-atoms'
import type { ChangeGroup, ChangeRow } from './lib/regions'
import type { ActiveRegion } from './use-active-region'

export interface ChangeListProps {
  groups: ChangeGroup[]
  /** The page on the sheet now. */
  current: number
  activeRegion: ActiveRegion
  /** Show this change: turn to its page and bring its box into view. */
  onShow: (number: number) => void
  /** The page Piloti is reading now, or null. */
  loadingPage: number | null
  /** A refused run on the page on screen, with the copy key for why. */
  error: { message: string; retryable: boolean } | null
  onRetry: () => void
  /** The marking button, when the panel is where it lives (below the sheet on narrow screens). */
  action?: ReactNode
  className?: string
}

export function ChangeList({
  groups,
  current,
  activeRegion,
  onShow,
  loadingPage,
  error,
  onRetry,
  action,
  className,
}: ChangeListProps): JSX.Element {
  const t = useTranslations('files')
  const listRef = useRef<HTMLElement | null>(null)
  const count = groups.reduce((sum, group) => sum + group.rows.length, 0)
  const { pinned } = activeRegion

  // A box pinned on the sheet brings its row into view here, without moving
  // the dialog around it (`scrollIntoView` would scroll every ancestor).
  useEffect(() => {
    const list = listRef.current
    if (pinned === null || !list) return
    const row = list.querySelector<HTMLElement>(`[data-change="${pinned}"]`)
    if (!row) return
    const top = row.offsetTop - list.offsetTop
    if (top < list.scrollTop || top + row.offsetHeight > list.scrollTop + list.clientHeight) {
      list.scrollTop = top - list.clientHeight / 2 + row.offsetHeight / 2
    }
  }, [pinned])

  const pagesShown = new Set(groups.map((group) => group.page))
  return (
    <aside
      ref={listRef}
      aria-label={t('compare.changesRegion')}
      className={cn('relative flex flex-col gap-4 overflow-y-auto p-4 *:shrink-0', className)}
      data-testid="compare-changes"
    >
      {action}
      {error && (
        <Alert variant="destructive" data-testid="compare-mark-error">
          <AlertDescription className="text-error">
            <p>{error.message}</p>
            {error.retryable && (
              <Button variant="outline" size="sm" className="mt-1" onClick={onRetry} data-testid="compare-mark-retry">
                <RotateCw aria-hidden />
                {t('compare.retry')}
              </Button>
            )}
          </AlertDescription>
        </Alert>
      )}

      {(count > 0 || groups.length > 0 || loadingPage !== null) && (
        <section className="space-y-3" aria-labelledby="compare-changes-heading">
          <SectionLabel as="h2" id="compare-changes-heading">
            {t('compare.changesHeading', { count })}
          </SectionLabel>
          {groups.map((group) => (
            <PageGroup
              key={group.page}
              group={group}
              shownNow={group.page === current}
              activeRegion={activeRegion}
              onShow={onShow}
              loading={loadingPage === group.page}
            />
          ))}
          {loadingPage !== null && !pagesShown.has(loadingPage) && (
            <PageGroup
              group={{ page: loadingPage, rows: [], notes: [] }}
              shownNow={loadingPage === current}
              activeRegion={activeRegion}
              onShow={onShow}
              loading
            />
          )}
          {count > 0 && <p className="text-muted-foreground text-xs">{t('compare.caveat')}</p>}
        </section>
      )}
    </aside>
  )
}

function PageGroup({
  group,
  shownNow,
  activeRegion,
  onShow,
  loading,
}: {
  group: ChangeGroup
  shownNow: boolean
  activeRegion: ActiveRegion
  onShow: (number: number) => void
  loading: boolean
}): JSX.Element {
  const t = useTranslations('files')
  return (
    <div className="space-y-1" data-testid="compare-page-group" data-page={group.page}>
      <h3 className="flex items-baseline gap-2 text-xs font-medium">
        {t('compare.pageGroup', { page: group.page })}
        {shownNow && <span className="text-muted-foreground font-normal">{t('compare.pageGroupShown')}</span>}
      </h3>
      {group.rows.length > 0 && (
        <ol className="space-y-0.5">
          {group.rows.map((row) => (
            <ChangeRowButton key={row.number} row={row} activeRegion={activeRegion} onShow={onShow} />
          ))}
        </ol>
      )}
      {group.notes.map((note) => (
        <p key={note} className="text-muted-foreground px-2 text-sm">
          {note}
        </p>
      ))}
      {loading && (
        <div className="space-y-2 px-2 pt-1" data-testid="compare-mark-loading">
          {[0, 1, 2].map((index) => (
            <div key={index} className="flex items-center gap-2">
              <Skeleton className="size-5 rounded-sm" />
              <Skeleton className="h-4 flex-1" />
            </div>
          ))}
          <p className="text-muted-foreground text-xs">{t('compare.markSlow')}</p>
        </div>
      )}
    </div>
  )
}

function ChangeRowButton({
  row,
  activeRegion,
  onShow,
}: {
  row: ChangeRow
  activeRegion: ActiveRegion
  onShow: (number: number) => void
}): JSX.Element {
  const t = useTranslations('files')
  const { number, region, sentence } = row
  const { active, pinned, preview } = activeRegion
  const isActive = active === number
  const sentenceId = `compare-change-${number}-sentence`
  return (
    <li>
      <button
        type="button"
        data-testid="compare-change"
        data-change={number}
        data-active={isActive || undefined}
        aria-current={pinned === number ? 'true' : undefined}
        aria-label={t('compare.changeShow', { number, label: region.label })}
        aria-describedby={sentence ? sentenceId : undefined}
        onPointerEnter={() => preview(number)}
        onPointerLeave={() => preview(null)}
        onFocus={() => preview(number)}
        onBlur={() => preview(null)}
        onClick={() => onShow(number)}
        className={cn(
          'duration-quick flex w-full items-start gap-2 rounded-md p-2 text-left text-sm transition-colors ease-out hover:bg-accent pointer-coarse:min-h-11',
          isActive && 'bg-accent',
        )}
      >
        <ChangeBadge number={number} active={isActive} className="mt-px" />
        <span className="min-w-0 flex-1">
          <span className="block font-medium">{region.label}</span>
          {sentence && (
            <span id={sentenceId} className="text-muted-foreground mt-0.5 block text-xs leading-relaxed">
              {sentence}
            </span>
          )}
        </span>
      </button>
    </li>
  )
}
