'use client'

import { useEffect, useRef, type JSX, type RefObject } from 'react'
import { ArrowLeft, LocateFixed, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Spinner } from '@/components/ui/spinner'
import { DraftCard, MarkRowContent, ThreadCard, markRowClassName } from '@/features/documents'
import { useTranslations } from '@/i18n'
import { bimCopy } from '@/i18n/namespaces/bim'
import { filesCopy } from '@/i18n/namespaces/files'
import { annotationSnapshotHref } from '@/lib/annotations/client'
import type { AnnotationView } from '@/lib/annotations/types'
import type { MarksNotice, ModelMarks } from '../hooks/use-model-marks'
import { ModelMarkCarry, ModelMarksExport } from './model-marks-actions'
import { ViewerSurface } from './viewer'

/** One sentence per thing worth saying after a capture or a jump; null says nothing. */
function noticeLines(notice: MarksNotice | null): { key: string; values?: Record<string, number> }[] {
  if (!notice) return []
  switch (notice.kind) {
    case 'missing':
      return [{ key: 'marks.notice.missing', values: { count: notice.count } }]
    case 'planes':
      return [{ key: 'marks.notice.planes', values: { count: notice.count } }]
    case 'captureFailed':
      return [{ key: 'marks.notice.captureFailed' }]
    case 'jumpFailed':
      return [{ key: 'marks.notice.jumpFailed' }]
    case 'carryFailed':
      return [{ key: 'marks.notice.carryFailed' }]
    case 'cut':
      return [
        ...(notice.notices.selectionCut ? [{ key: 'marks.notice.selectionCut' }] : []),
        ...(notice.notices.visibilityDropped ? [{ key: 'marks.notice.visibilityDropped' }] : []),
        ...(notice.notices.noSnapshot ? [{ key: 'marks.notice.noSnapshot' }] : []),
      ]
  }
}

function JumpButton({ marks, annotation }: { marks: ModelMarks; annotation: AnnotationView }): JSX.Element {
  const t = useTranslations(bimCopy)
  return (
    <Button
      type="button"
      variant="outline"
      size="sm"
      className="h-7 gap-1.5 text-xs"
      data-testid="mark-jump"
      disabled={!marks.canJump}
      onClick={() => void marks.jump(annotation.id)}
    >
      <LocateFixed className="size-3.5" aria-hidden />
      {t('marks.jump')}
    </Button>
  )
}

function MarkList({ marks }: { marks: ModelMarks }): JSX.Element {
  const t = useTranslations(bimCopy)
  const files = useTranslations(filesCopy)
  const { review } = marks
  const rows = review.listed.filter((annotation) => annotation.anchor === 'viewpoint')
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-1">
      <div className="flex flex-1 gap-1" role="group" aria-label={files('review.filter')}>
        {(['open', 'closed'] as const).map((filter) => (
          <Button
            key={filter}
            type="button"
            size="sm"
            variant={review.filter === filter ? 'secondary' : 'ghost'}
            aria-pressed={review.filter === filter}
            className="h-7 px-2.5 text-xs"
            onClick={() => review.setFilter(filter)}
          >
            {files(`review.filters.${filter}`)}
            <span className="text-muted-foreground tabular-nums">{review.counts[filter]}</span>
          </Button>
        ))}
      </div>
      {marks.documentId && <ModelMarksExport documentId={marks.documentId} />}
      </div>
      {rows.length === 0 ? (
        <div className="px-1 py-3" data-testid="marks-empty">
          <p className="text-sm font-medium">{t('marks.empty.title')}</p>
          <p className="text-muted-foreground mt-1 text-xs leading-5">
            {review.canAnnotate ? t('marks.empty.body') : t('marks.empty.readOnly')}
          </p>
        </div>
      ) : (
        <ul className="flex flex-col" data-testid="marks-list">
          {rows.map((annotation) => (
            <li key={annotation.id} className="flex flex-col gap-1 pb-1">
              <button
                type="button"
                data-testid="review-row"
                aria-current={annotation.id === review.selectedId || undefined}
                className={markRowClassName(annotation.id === review.selectedId)}
                onClick={() => marks.openMark(annotation.id)}
              >
                <MarkRowContent annotation={annotation} viewerId={review.me} unread={review.unread.has(annotation.id)} />
              </button>
              <div className="flex flex-col gap-1.5 pl-11">
                <ModelMarkCarry marks={marks} annotation={annotation} />
                <JumpButton marks={marks} annotation={annotation} />
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

function OpenMark({ marks, annotation }: { marks: ModelMarks; annotation: AnnotationView }): JSX.Element {
  const t = useTranslations(bimCopy)
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center justify-between gap-2">
        <Button type="button" variant="ghost" size="sm" className="-ml-2 h-7 gap-1 px-2 text-xs" onClick={() => marks.openMark(null)}>
          <ArrowLeft className="size-3.5" aria-hidden />
          {t('marks.all')}
        </Button>
        <JumpButton marks={marks} annotation={annotation} />
      </div>
      {annotation.viewpoint?.hasSnapshot && (
        // The picture the mark was set on: the server serves it with the reader's access each time.
        // oxlint-disable-next-line next/no-img-element -- a private, never-cached binary; the image optimiser would fetch it without the session
        <img
          src={annotationSnapshotHref(annotation.documentId, annotation.id)}
          alt={t('marks.snapshot')}
          loading="lazy"
          className="border-border aspect-video w-full rounded-lg border object-cover"
          data-testid="mark-snapshot"
        />
      )}
      <ModelMarkCarry marks={marks} annotation={annotation} />
      <ThreadCard
        key={annotation.id}
        review={marks.review}
        annotation={annotation}
        placement="docked"
        canPickAssignee={marks.canPickAssignee}
      />
    </div>
  )
}

/**
 * The model's marks in one panel: the composer while one is being set, an open
 * mark's thread, or the list. All three are the review's own pieces
 * (`DraftCard`, `ThreadCard`, `MarkRowContent`); only the frame and the jump
 * are this feature's.
 */
export function ModelMarksPanel({ marks }: { marks: ModelMarks }): JSX.Element | null {
  if (!marks.available || !marks.open) return null
  return <OpenPanel marks={marks} />
}

/**
 * Focus, as a non-modal panel inside the stage's dialog: opening moves it into the panel, a composer that opens
 * (or a capture that ends in one) takes it, and closing hands it back to what had it, the dock's button.
 */
function usePanelFocus(panelRef: RefObject<HTMLDivElement | null>, composing: boolean): void {
  useEffect(() => {
    const before = document.activeElement instanceof HTMLElement ? document.activeElement : null
    const panel = panelRef.current
    if (panel && !panel.contains(document.activeElement)) panel.focus({ preventScroll: true })
    return () => {
      if (before?.isConnected && (!panel || panel.contains(document.activeElement) || document.activeElement === document.body)) {
        before.focus({ preventScroll: true })
      }
    }
  }, [panelRef])
  useEffect(() => {
    if (!composing) return
    const body = panelRef.current?.querySelector<HTMLElement>('[data-testid="review-draft-body"]')
    if (body && document.activeElement !== body) body.focus({ preventScroll: true })
  }, [composing, panelRef])
}

function OpenPanel({ marks }: { marks: ModelMarks }): JSX.Element {
  const t = useTranslations(bimCopy)
  const { review } = marks
  const panelRef = useRef<HTMLDivElement | null>(null)
  usePanelFocus(panelRef, review.draft !== null && !marks.capturing)
  const selected = review.annotations.find((annotation) => annotation.id === review.selectedId) ?? null
  const lines = noticeLines(marks.notice)
  return (
    <div className="absolute top-16 right-3 z-30 flex max-h-[calc(100%-9rem)] w-[min(24rem,calc(100%-1.5rem))] sm:top-20 sm:right-4">
      <ViewerSurface
        ref={panelRef}
        tabIndex={-1}
        role="dialog"
        aria-label={t('marks.title')}
        data-testid="model-marks-panel"
        className="flex min-h-0 w-full flex-col gap-2 p-3 outline-none"
      >
        <div className="flex items-center justify-between gap-2">
          <h2 className="text-sm font-semibold">{t('marks.title')}</h2>
          <Button type="button" variant="ghost" size="icon" className="size-7" aria-label={t('marks.close')} onClick={marks.close}>
            <X className="size-4" aria-hidden />
          </Button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto">
          {marks.capturing ? (
            <p className="text-muted-foreground flex items-center gap-2 py-3 text-sm" role="status">
              <Spinner size="sm" />
              {t('marks.capturing')}
            </p>
          ) : review.draft ? (
            <div className="flex flex-col gap-2">
              <DraftCard review={review} draft={review.draft} placement="docked" canPickAssignee={marks.canPickAssignee} />
              <Button type="button" variant="ghost" size="sm" className="self-start text-xs" onClick={() => review.setDraft(null)}>
                {t('marks.cancel')}
              </Button>
            </div>
          ) : selected ? (
            <OpenMark marks={marks} annotation={selected} />
          ) : (
            <MarkList marks={marks} />
          )}
        </div>
        {lines.length > 0 && (
          <div className="text-muted-foreground flex items-start gap-2 text-xs leading-5" role="status" data-testid="marks-notice">
            <p className="min-w-0 flex-1">
              {lines.map((line) => t(line.key, line.values)).join(' ')}
            </p>
            <Button type="button" variant="ghost" size="sm" className="-my-1 h-6 shrink-0 px-2 text-xs" onClick={marks.dismissNotice}>
              {t('marks.dismiss')}
            </Button>
          </div>
        )}
      </ViewerSurface>
    </div>
  )
}
