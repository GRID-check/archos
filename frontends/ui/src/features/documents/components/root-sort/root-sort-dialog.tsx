'use client'

/**
 * „Alle Dateien in Ordner einsortieren…“: the dialog that runs one root sort.
 *
 * Intro (what the root holds) → planning (Piloti judges each chunk, then
 * groups what no folder fits) → review (the tree, the person's choices) →
 * applying (kept folders created, then kept files moved) → done, with one
 * Rückgängig that sets every moved file back in the root. Nothing moves
 * before the review's button. The dialog stays open while a run works: a
 * close during planning or applying asks first, and says what would be lost.
 */

import type { JSX } from 'react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { Spinner } from '@/components/ui/spinner'
import { Progress } from '@/components/ui/progress'
import { Button } from '@/components/ui/button'
import { Alert } from '@/components/ui/alert'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { useTranslations } from '@/i18n'
import { fetchRootSortScan, type RootSortRunProgress } from '@/lib/filing/root-sort-client'
import type { RootSortScan, RootSortShelf } from '@/lib/filing/root-sort-types'
import {
  keptMoves,
  NO_CHANGES,
  type PlacementInput,
  type PlacementState,
} from '../../lib/placement-tree'
import {
  applyKeptMoves,
  judgeRoot,
  undoMoves,
  type AppliedRun,
  type JudgedRoot,
} from '../../lib/root-sort-run'
import { RootSortReview } from './root-sort-review'

export interface RootSortDialogProps {
  shelf: RootSortShelf
  open: boolean
  onOpenChange: (open: boolean) => void
  /** Called after files moved, and after an undo, so the listing reads the shelf again. */
  onApplied?: () => void
}

type Phase =
  'loading' | 'intro' | 'planning' | 'review' | 'applying' | 'done' | 'undoing' | 'undone' | 'error'

const BUSY: readonly Phase[] = ['planning', 'applying', 'undoing']

export function RootSortDialog({
  shelf,
  open,
  onOpenChange,
  onApplied,
}: RootSortDialogProps): JSX.Element {
  const t = useTranslations('files')
  const [phase, setPhase] = useState<Phase>('loading')
  const [scan, setScan] = useState<RootSortScan | null>(null)
  const [judged, setJudged] = useState<JudgedRoot | null>(null)
  const [choices, setChoices] = useState<PlacementState>(NO_CHANGES)
  const [onlyUnsure, setOnlyUnsure] = useState(false)
  const [progress, setProgress] = useState<RootSortRunProgress>({ done: 0, total: 0 })
  const [grouping, setGrouping] = useState<number | null>(null)
  const [applied, setApplied] = useState<AppliedRun | null>(null)
  const [undoFailed, setUndoFailed] = useState(0)
  const [notice, setNotice] = useState<'ensureFailed' | null>(null)
  const [confirmingClose, setConfirmingClose] = useState(false)
  const [attempt, setAttempt] = useState(0)
  // Each run takes a number; a result that comes back under an older number is dropped.
  const session = useRef(0)
  const onAppliedRef = useRef(onApplied)
  onAppliedRef.current = onApplied

  const busy = BUSY.includes(phase)

  // Opening reads the root afresh; closing forgets the run (a run in flight is abandoned, or finishes quietly).
  useEffect(() => {
    if (!open) {
      session.current += 1
      return
    }
    const id = ++session.current
    setPhase('loading')
    setScan(null)
    setJudged(null)
    setChoices(NO_CHANGES)
    setOnlyUnsure(false)
    setApplied(null)
    setNotice(null)
    setConfirmingClose(false)
    void fetchRootSortScan(shelf)
      .then((next) => {
        if (id !== session.current) return
        setScan(next)
        setPhase('intro')
      })
      .catch(() => {
        if (id === session.current) setPhase('error')
      })
  }, [open, shelf, attempt])

  const input = useMemo<PlacementInput | null>(
    () =>
      scan && judged
        ? {
            folders: scan.folders,
            documents: scan.documents,
            placements: judged.run.placements,
            newFolders: judged.proposals,
          }
        : null,
    [scan, judged]
  )
  const kept = useMemo(() => (input ? keptMoves(input, choices) : null), [input, choices])

  const startPlanning = async (current: RootSortScan): Promise<void> => {
    const id = ++session.current
    setPhase('planning')
    setProgress({ done: 0, total: current.documents.length })
    setGrouping(null)
    setNotice(null)
    const result = await judgeRoot(
      shelf,
      current,
      (next) => {
        if (id === session.current) setProgress(next)
      },
      (count) => {
        if (id === session.current) setGrouping(count)
      }
    ).catch(() => null)
    if (id !== session.current) return
    // Planning does not throw on a bad chunk; a failure here is the whole call. Back to the start, to try again.
    if (!result) {
      setPhase('intro')
      return
    }
    setJudged(result)
    setChoices(NO_CHANGES)
    setPhase('review')
  }

  const apply = async (): Promise<void> => {
    if (!kept) return
    const id = ++session.current
    setPhase('applying')
    setNotice(null)
    setProgress({ done: 0, total: kept.moves.length })
    try {
      const result = await applyKeptMoves(shelf, kept, (next) => {
        if (id === session.current) setProgress(next)
      })
      onAppliedRef.current?.()
      if (id !== session.current) return
      setApplied(result)
      setPhase('done')
    } catch {
      if (id !== session.current) return
      setNotice('ensureFailed')
      setPhase('review')
    }
  }

  const undo = async (): Promise<void> => {
    if (!applied) return
    const id = ++session.current
    setPhase('undoing')
    setProgress({ done: 0, total: applied.moved.length })
    const result = await undoMoves(applied.moved, (next) => {
      if (id === session.current) setProgress(next)
    })
    onAppliedRef.current?.()
    if (id !== session.current) return
    setUndoFailed(result.failed.length)
    setPhase('undone')
  }

  const requestClose = (): void => {
    if (busy) setConfirmingClose(true)
    else onOpenChange(false)
  }
  const leave = (): void => {
    setConfirmingClose(false)
    onOpenChange(false)
  }

  const moveCount = kept?.moves.length ?? 0
  const partial =
    judged && judged.run.failedDocumentIds.length > 0 ? judged.run.failedDocumentIds.length : 0
  const documentCount = scan?.documents.length ?? 0
  const folderCount = scan?.folders.length ?? 0

  return (
    <Dialog open={open} onOpenChange={(next) => (next ? onOpenChange(true) : requestClose())}>
      <DialogContent
        className="flex max-h-[min(92dvh,56rem)] flex-col gap-4 sm:max-w-4xl"
        closeLabel={t('rootSort.close')}
      >
        <DialogHeader>
          <DialogTitle className="pr-10 text-base leading-snug">{t('rootSort.title')}</DialogTitle>
          <DialogDescription>{t('rootSort.description')}</DialogDescription>
        </DialogHeader>

        <div className="min-h-0 flex-1 overflow-y-auto">
          {phase === 'loading' && (
            <p className="text-muted-foreground text-sm">{t('rootSort.intro.reading')}</p>
          )}

          {phase === 'error' && (
            <Alert variant="destructive">{t('rootSort.intro.loadFailed')}</Alert>
          )}

          {phase === 'intro' && scan && (
            <div className="flex flex-col gap-3 text-sm">
              <p className="font-medium">
                {t('rootSort.intro.files', { count: documentCount })} ·{' '}
                {t('rootSort.intro.folders', { count: folderCount })}
              </p>
              {scan.unreadable > 0 && (
                <p className="text-muted-foreground">
                  {t('rootSort.intro.unreadable', { count: scan.unreadable })}
                </p>
              )}
              {scan.truncated && (
                <p className="text-muted-foreground">{t('rootSort.intro.truncated')}</p>
              )}
              {documentCount === 0 && (
                <p className="text-muted-foreground">{t('rootSort.intro.nothing')}</p>
              )}
              {documentCount > 0 && folderCount === 0 && (
                <p className="text-muted-foreground">{t('rootSort.intro.noFolders')}</p>
              )}
            </div>
          )}

          {phase === 'planning' && (
            <div className="flex flex-col gap-3 py-2 text-sm">
              {grouping === null ? (
                <>
                  <p>
                    {t('rootSort.planning.judging', { done: progress.done, total: progress.total })}
                  </p>
                  <Progress
                    value={progress.total === 0 ? 0 : (progress.done / progress.total) * 100}
                  />
                </>
              ) : (
                <div className="flex items-center gap-3">
                  <Spinner aria-hidden />
                  <p>{t('rootSort.planning.grouping', { count: grouping })}</p>
                </div>
              )}
            </div>
          )}

          {phase === 'review' && input && (
            <div className="flex flex-col gap-3">
              {notice === 'ensureFailed' && (
                <Alert variant="destructive">{t('rootSort.apply.ensureFailed')}</Alert>
              )}
              {judged && partial > 0 && (
                <p className="text-muted-foreground text-sm">
                  {t('rootSort.planning.partial', { count: partial })}
                </p>
              )}
              {judged && judged.overflow > 0 && (
                <p className="text-muted-foreground text-sm">
                  {t('rootSort.planning.overflow', { count: judged.overflow })}
                </p>
              )}
              <RootSortReview
                input={input}
                state={choices}
                onStateChange={setChoices}
                onlyUnsure={onlyUnsure}
                onOnlyUnsureChange={setOnlyUnsure}
              />
            </div>
          )}

          {phase === 'applying' && (
            <div className="flex flex-col gap-3 py-2 text-sm">
              <p>{t('rootSort.apply.progress', { done: progress.done, total: progress.total })}</p>
              <Progress value={progress.total === 0 ? 0 : (progress.done / progress.total) * 100} />
            </div>
          )}

          {phase === 'undoing' && (
            <div className="flex flex-col gap-3 py-2 text-sm">
              <p>{t('rootSort.apply.progress', { done: progress.done, total: progress.total })}</p>
              <Progress value={progress.total === 0 ? 0 : (progress.done / progress.total) * 100} />
            </div>
          )}

          {phase === 'done' && applied && (
            <div className="flex flex-col gap-3 text-sm">
              <p className="font-medium">
                {t('rootSort.done.moved', { count: applied.moved.length })}
              </p>
              {applied.failed.length > 0 && (
                <p className="text-error">
                  {t('rootSort.done.failed', { count: applied.failed.length })}
                </p>
              )}
              <p className="text-muted-foreground">{t('rootSort.done.foldersKept')}</p>
            </div>
          )}

          {phase === 'undone' && (
            <div className="flex flex-col gap-3 text-sm">
              <p className="font-medium">{t('rootSort.done.undone')}</p>
              {undoFailed > 0 && (
                <p className="text-error">{t('rootSort.done.undoFailed', { count: undoFailed })}</p>
              )}
              <p className="text-muted-foreground">{t('rootSort.done.foldersKept')}</p>
            </div>
          )}
        </div>

        <DialogFooter className="gap-2">
          {confirmingClose ? (
            <>
              <p className="text-muted-foreground mr-auto text-sm">
                {t(
                  phase === 'applying'
                    ? 'rootSort.confirmClose.applying'
                    : 'rootSort.confirmClose.planning'
                )}
              </p>
              <Button type="button" variant="outline" onClick={() => setConfirmingClose(false)}>
                {t('rootSort.confirmClose.keep')}
              </Button>
              <Button type="button" onClick={leave}>
                {t('rootSort.confirmClose.leave')}
              </Button>
            </>
          ) : (
            <>
              {phase === 'intro' && (
                <>
                  <Button type="button" variant="outline" onClick={requestClose}>
                    {t('rootSort.cancel')}
                  </Button>
                  <Button
                    type="button"
                    disabled={documentCount === 0 || folderCount === 0}
                    onClick={() => scan && void startPlanning(scan)}
                  >
                    {t('rootSort.start')}
                  </Button>
                </>
              )}
              {phase === 'planning' && (
                <Button type="button" variant="outline" onClick={requestClose}>
                  {t('rootSort.cancel')}
                </Button>
              )}
              {phase === 'review' && (
                <>
                  <Button type="button" variant="outline" onClick={requestClose}>
                    {t('rootSort.cancel')}
                  </Button>
                  <Button type="button" disabled={moveCount === 0} onClick={() => void apply()}>
                    {moveCount === 0
                      ? t('rootSort.apply.nothing')
                      : t('rootSort.apply.move', { count: moveCount })}
                  </Button>
                </>
              )}
              {phase === 'done' && (
                <>
                  <Button
                    type="button"
                    variant="outline"
                    onClick={() => void undo()}
                    disabled={!applied || applied.moved.length === 0}
                  >
                    {t('rootSort.done.undo')}
                  </Button>
                  <Button type="button" onClick={() => onOpenChange(false)}>
                    {t('rootSort.done.close')}
                  </Button>
                </>
              )}
              {phase === 'error' && (
                <>
                  <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
                    {t('rootSort.done.close')}
                  </Button>
                  <Button type="button" onClick={() => setAttempt((count) => count + 1)}>
                    {t('rootSort.retry')}
                  </Button>
                </>
              )}
              {phase === 'undone' && (
                <Button type="button" onClick={() => onOpenChange(false)}>
                  {t('rootSort.done.close')}
                </Button>
              )}
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
