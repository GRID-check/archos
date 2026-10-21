'use client'

/**
 * „Alle Dateien in Ordner einsortieren…“: the dialog that shows one root sort.
 *
 * The server owns the run (ADR-0121). The dialog starts it, reads it, and sends
 * the person's answers, one request each; it never works through the documents
 * itself. Closing is always safe: the run goes on, and reopening the dialog
 * lands where the server got to. While a run works the dialog re-reads it every
 * two seconds; that poll is the only repeated request it makes.
 */

import type { JSX } from 'react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { Alert } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { useTranslations } from '@/i18n'
import {
  applyRootSortRun,
  cancelRootSortRun,
  fetchRootSortRun,
  fetchRootSortSummary,
  startRootSort,
  undoRootSortRun,
} from '@/lib/filing/root-sort-client'
import type {
  RootSortRunStatus,
  RootSortRunView,
  RootSortShelf,
  RootSortSummary,
} from '@/lib/filing/root-sort-types'
import {
  keptMoves,
  NO_CHANGES,
  type PlacementInput,
  type PlacementState,
} from '../../lib/placement-tree'
import { isSortConflict, isWorking, phaseOf } from '../../lib/root-sort-phase'
import { RootSortReview } from './root-sort-review'
import { RootSortOutcome, RootSortProgress } from './root-sort-status'

/** How often a working run is read again. */
const POLL_MS = 2000
/** Failed moves named in the outcome; the rest are counted. */
const NAMED_FAILURES = 5

export interface RootSortDialogProps {
  shelf: RootSortShelf
  open: boolean
  onOpenChange: (open: boolean) => void
  /** Called once when a run has moved files (or moved them back), so the listing reads the shelf again. */
  onApplied?: () => void
}

type ActionError = 'conflict' | 'generic'

/** A run that changed what the listing shows: its files moved, or moved back. */
function changedListing(status: RootSortRunStatus): boolean {
  return status === 'applied' || status === 'undone'
}

export function RootSortDialog({
  shelf,
  open,
  onOpenChange,
  onApplied,
}: RootSortDialogProps): JSX.Element {
  const t = useTranslations('files')
  const [summary, setSummary] = useState<RootSortSummary | null>(null)
  const [run, setRun] = useState<RootSortRunView | null>(null)
  // The last review the dialog saw: kept after the run moves on, to name files that failed to move.
  const [reviewed, setReviewed] = useState<RootSortRunView['review']>(null)
  const [loadFailed, setLoadFailed] = useState(false)
  const [busy, setBusy] = useState(false)
  const [actionError, setActionError] = useState<ActionError | null>(null)
  const [choices, setChoices] = useState<PlacementState>(NO_CHANGES)
  const [onlyUnsure, setOnlyUnsure] = useState(false)
  const [attempt, setAttempt] = useState(0)
  // Every request answers for the open it was sent in: a reply that comes back after a close is dropped.
  const session = useRef(0)
  const onAppliedRef = useRef(onApplied)
  onAppliedRef.current = onApplied

  // The run as it stands: the one the dialog follows, else the root's latest.
  const current = run ?? summary?.run ?? null
  const phase = phaseOf(summary, run, loadFailed)
  const followedId = current?.id ?? null
  const followedStatus = current?.status ?? null

  useEffect(() => {
    if (!open) return
    const id = ++session.current
    setSummary(null)
    setRun(null)
    setReviewed(null)
    setLoadFailed(false)
    setBusy(false)
    setActionError(null)
    setChoices(NO_CHANGES)
    setOnlyUnsure(false)
    fetchRootSortSummary(shelf).then(
      (next) => {
        if (id !== session.current) return
        setSummary(next)
        // The run may have finished while the dialog was shut, so the listing may predate it.
        if (next.run && changedListing(next.run.status)) onAppliedRef.current?.()
      },
      () => {
        if (id === session.current) setLoadFailed(true)
      }
    )
    return () => {
      session.current += 1
    }
  }, [open, shelf, attempt])

  // One timer while a run is worked: re-read it every POLL_MS until it stops working.
  useEffect(() => {
    if (!open || followedId === null || followedStatus === null || !isWorking(followedStatus)) return
    const id = session.current
    let inFlight = false
    const timer = window.setInterval(() => {
      if (inFlight) return
      inFlight = true
      fetchRootSortRun(followedId)
        .then(
          (next) => {
            if (id !== session.current) return
            setRun(next)
            setActionError(null)
            if (next.review) setReviewed(next.review)
            if (changedListing(next.status)) onAppliedRef.current?.()
          },
          () => {
            if (id === session.current) setActionError('generic')
          }
        )
        .finally(() => {
          inFlight = false
        })
    }, POLL_MS)
    return () => window.clearInterval(timer)
  }, [open, followedId, followedStatus])

  const review = current?.review ?? null
  const input = useMemo<PlacementInput | null>(
    () =>
      review
        ? {
            folders: review.folders,
            documents: review.documents,
            placements: review.placements,
            newFolders: review.newFolders,
          }
        : null,
    [review]
  )
  const kept = useMemo(() => (input ? keptMoves(input, choices) : null), [input, choices])
  const moveCount = kept?.moves.length ?? 0
  const names = useMemo(
    () => new Map((reviewed?.documents ?? []).map((document) => [document.id, document.name])),
    [reviewed]
  )
  const failedNames = (current?.moveFailures ?? []).flatMap((failure) => {
    const name = names.get(failure.documentId)
    return name ? [name] : []
  })

  /** Sends one request for the run and shows what it answers; a stale answer is dropped. */
  const perform = (action: () => Promise<RootSortRunView>): void => {
    const id = session.current
    setBusy(true)
    setActionError(null)
    action()
      .then(
        (next) => {
          if (id !== session.current) return
          setRun(next)
          if (next.review) setReviewed(next.review)
        },
        (error: unknown) => {
          if (id === session.current) setActionError(isSortConflict(error) ? 'conflict' : 'generic')
        }
      )
      .finally(() => {
        if (id === session.current) setBusy(false)
      })
  }

  const close = (): void => onOpenChange(false)
  const canStart = summary !== null && summary.files > 0 && summary.folders > 0
  const canCancel = current !== null && (current.status === 'judging' || current.status === 'grouping' || current.status === 'ready')
  const cancel = (): void => {
    if (current) perform(() => cancelRootSortRun(current.id))
  }
  const start = (): void => perform(() => startRootSort(shelf))

  const judgedNothing = review !== null && review.documents.length > 0 && review.failedDocumentIds.length >= review.documents.length

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="flex max-h-[min(92dvh,56rem)] flex-col gap-4 sm:max-w-4xl"
        closeLabel={t('rootSort.close')}
      >
        <DialogHeader>
          <DialogTitle className="pr-10 text-base leading-snug">{t('rootSort.title')}</DialogTitle>
          <DialogDescription>{t('rootSort.description')}</DialogDescription>
        </DialogHeader>

        <div className="min-h-0 flex-1 overflow-y-auto">
          {actionError !== null && (
            <Alert variant="destructive" className="mb-3">
              {actionError === 'conflict' ? t('rootSort.errors.conflict') : t('rootSort.errors.generic')}
            </Alert>
          )}

          {phase === 'loading' && (
            <p className="text-muted-foreground text-sm">{t('rootSort.intro.reading')}</p>
          )}

          {phase === 'failed' && current === null && (
            <Alert variant="destructive">{t('rootSort.intro.loadFailed')}</Alert>
          )}

          {phase === 'intro' && summary && (
            <div className="flex flex-col gap-3 text-sm">
              <p className="font-medium">
                {t('rootSort.intro.files', { count: summary.files })} ·{' '}
                {t('rootSort.intro.folders', { count: summary.folders })}
              </p>
              {summary.unreadable > 0 && (
                <p className="text-muted-foreground">
                  {t('rootSort.intro.unreadable', { count: summary.unreadable })}
                </p>
              )}
              {summary.truncated && (
                <p className="text-muted-foreground">{t('rootSort.intro.truncated')}</p>
              )}
              {summary.files === 0 && (
                <p className="text-muted-foreground">{t('rootSort.intro.nothing')}</p>
              )}
              {summary.files > 0 && summary.folders === 0 && (
                <p className="text-muted-foreground">{t('rootSort.intro.noFolders')}</p>
              )}
            </div>
          )}

          {current !== null && isWorking(current.status) && (
            <RootSortProgress
              status={current.status}
              done={current.progress.done}
              total={current.progress.total}
            />
          )}

          {phase === 'review' && input && (
            <div className="flex flex-col gap-3">
              {current?.groupingError && (
                <Alert>{t('rootSort.review.groupingFailed')}</Alert>
              )}
              {review && review.failedDocumentIds.length > 0 && !judgedNothing && (
                <p className="text-muted-foreground text-sm">
                  {t('rootSort.review.failed', { count: review.failedDocumentIds.length })}
                </p>
              )}
              <RootSortReview
                input={input}
                state={choices}
                onStateChange={setChoices}
                onlyUnsure={onlyUnsure}
                onOnlyUnsureChange={setOnlyUnsure}
                judgedNothing={judgedNothing}
              />
            </div>
          )}

          {phase === 'done' && current && (
            <RootSortOutcome
              moved={current.moved}
              failedCount={current.moveFailures.length}
              failedNames={failedNames.slice(0, NAMED_FAILURES)}
            />
          )}

          {phase === 'undone' && (
            <div className="flex flex-col gap-2 text-sm">
              <p className="font-medium">{t('rootSort.done.undone')}</p>
              {current && current.undoFailures.length > 0 && (
                <p className="text-destructive">{t('rootSort.done.undoFailed', { count: current.undoFailures.length })}</p>
              )}
            </div>
          )}

          {phase === 'cancelled' && <p className="text-sm">{t('rootSort.cancelled')}</p>}

          {phase === 'failed' && current && (
            <div className="flex flex-col gap-2 text-sm">
              <p className="font-medium">{t('rootSort.failed')}</p>
              {current.error && <p className="text-muted-foreground break-words">{current.error}</p>}
            </div>
          )}
        </div>

        <DialogFooter className="gap-2">
          {phase === 'intro' && (
            <>
              <Button type="button" variant="outline" onClick={close}>
                {t('rootSort.close')}
              </Button>
              <Button type="button" disabled={busy || !canStart} onClick={start}>
                {t('rootSort.start')}
              </Button>
            </>
          )}
          {phase === 'working' && (
            <>
              {canCancel && (
                <Button type="button" variant="ghost" disabled={busy} onClick={cancel}>
                  {t('rootSort.cancel')}
                </Button>
              )}
              <Button type="button" variant="outline" onClick={close}>
                {t('rootSort.close')}
              </Button>
            </>
          )}
          {phase === 'review' && (
            <>
              <Button type="button" variant="ghost" disabled={busy} onClick={cancel}>
                {t('rootSort.cancel')}
              </Button>
              <Button type="button" variant="outline" onClick={close}>
                {t('rootSort.close')}
              </Button>
              <Button
                type="button"
                disabled={busy || moveCount === 0 || !kept}
                onClick={() => {
                  if (current && kept) perform(() => applyRootSortRun(current.id, kept.moves))
                }}
              >
                {moveCount === 0 ? t('rootSort.apply.nothing') : t('rootSort.apply.move', { count: moveCount })}
              </Button>
            </>
          )}
          {phase === 'done' && (
            <>
              <Button
                type="button"
                variant="outline"
                disabled={busy || !current}
                onClick={() => {
                  if (current) perform(() => undoRootSortRun(current.id))
                }}
              >
                {t('rootSort.done.undo')}
              </Button>
              <Button type="button" onClick={close}>
                {t('rootSort.close')}
              </Button>
            </>
          )}
          {(phase === 'undone' || phase === 'cancelled') && (
            <>
              <Button type="button" variant="outline" onClick={close}>
                {t('rootSort.close')}
              </Button>
              <Button type="button" disabled={busy || !canStart} onClick={start}>
                {t('rootSort.start')}
              </Button>
            </>
          )}
          {phase === 'failed' && current && (
            <>
              <Button type="button" variant="outline" onClick={close}>
                {t('rootSort.close')}
              </Button>
              <Button type="button" disabled={busy} onClick={start}>
                {t('rootSort.restart')}
              </Button>
            </>
          )}
          {phase === 'failed' && current === null && (
            <>
              <Button type="button" variant="outline" onClick={close}>
                {t('rootSort.close')}
              </Button>
              <Button type="button" onClick={() => setAttempt((count) => count + 1)}>
                {t('rootSort.retry')}
              </Button>
            </>
          )}
          {phase === 'loading' && (
            <Button type="button" variant="outline" onClick={close}>
              {t('rootSort.close')}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
