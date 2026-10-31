'use client'

/**
 * A Skizze traced over a PDF page, in the editor (S6, ADR-0150).
 *
 *   - {@link UnderlayBanner}: above the canvas, what the strokes lie on
 *     („Liegt auf Lageplan.pdf, Fassung 3, S. 2“) and the doctrine (nothing is
 *     measured on it); when the base has a newer Fassung, „liegt auf Fassung 3,
 *     aktuell 4“ and „Auf neue Fassung übertragen“; and the way
 *     back, „Zur Seite N der Fassung“, the review of the page it lies on
 *     (slice 1: a page has one canvas, and the Skizze links back to it).
 *   - {@link UnderlayMoveDialog}: the move, decided by a person, never on its
 *     own (research r2): the page it would land on (by its label, else its
 *     number), old and new shown alone or overlaid, and „Übertragen“, which
 *     saves the Skizze's next Fassung. Pins and links stay on their elements.
 *
 * Both pages come from the raster route with the reader's rights.
 */

import { ArrowUpLeft, Layers } from 'lucide-react'
import Link from 'next/link'
import { useEffect, useState } from 'react'
import { getUnderlayMovePlan, moveSketchUnderlay, pageRasterUrl, SketchRequestError } from '@/adapters/api/diagrams-client'
import type { SketchUnderlayView, UnderlayMovePlan } from '@/lib/diagrams/sketch-underlay-wire'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { useTranslations } from '@/i18n'
import { diagramsCopy } from '@/i18n/namespaces/diagrams'
import { pageReviewHref } from '@/features/documents/sketch-link-target'

export interface UnderlayBannerProps {
  underlay: SketchUnderlayView
  /** Whether the base page reached this canvas (`sketch-underlay-load.ts`). */
  shown: boolean | null
  /** The Skizze, for the move. */
  documentId: string
  baseVersionId: string | null
  canMove: boolean
  /** The move saved a new Fassung: the editor reopens on it. */
  onMoved: (versionNumber: number) => void
  /** The project both lie in, for the way back to the page; null offers none. */
  projectId?: string | null
  /** Unsaved strokes: leaving would lose them, so the way back waits for the save. */
  dirty?: boolean
}

export function UnderlayBanner({ underlay, shown, documentId, baseVersionId, canMove, onMoved, projectId = null, dirty = false }: UnderlayBannerProps) {
  const t = useTranslations(diagramsCopy)
  const [moving, setMoving] = useState(false)
  if (underlay.state === 'unavailable' || shown === false) {
    return (
      <p className="text-muted-foreground shrink-0 text-xs" role="status" data-testid="sketch-underlay-unavailable">
        {t('underlay.unavailable')}
      </p>
    )
  }
  return (
    <div className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-1 text-xs" data-testid="sketch-underlay">
      <Layers className="text-muted-foreground size-3.5" aria-hidden />
      <span className="text-foreground">
        {t('underlay.onVersion', { title: underlay.title, number: String(underlay.versionNumber), page: String(underlay.ref.page) })}
      </span>
      {underlay.newer ? (
        <span className="text-warning font-medium" data-testid="sketch-underlay-drift">
          {t('underlay.drift', { from: String(underlay.versionNumber), to: String(underlay.newer.versionNumber) })}
        </span>
      ) : null}
      <span className="text-muted-foreground">{t('underlay.noMeasure')}</span>
      {projectId ? <BackToPage projectId={projectId} underlay={underlay} dirty={dirty} /> : null}
      {underlay.newer && canMove ? (
        <Button size="sm" variant="outline" className="ml-auto h-7" onClick={() => setMoving(true)} data-testid="sketch-underlay-move">
          {t('underlay.moveAction')}
        </Button>
      ) : null}
      {underlay.newer ? (
        <UnderlayMoveDialog
          open={moving}
          onOpenChange={setMoving}
          documentId={documentId}
          baseVersionId={baseVersionId}
          underlay={underlay}
          onMoved={(number) => {
            setMoving(false)
            onMoved(number)
          }}
        />
      ) : null}
    </div>
  )
}

/** „Zur Seite N der Fassung“: the review of the page the Skizze lies on, at that page. */
function BackToPage({ projectId, underlay, dirty }: { projectId: string; underlay: SketchUnderlayView; dirty: boolean }) {
  const t = useTranslations(diagramsCopy)
  const label = (
    <>
      <ArrowUpLeft className="size-3.5" aria-hidden />
      {t('underlay.backToPage', { page: String(underlay.ref.page) })}
    </>
  )
  if (dirty) {
    return (
      <Button size="sm" variant="ghost" className="h-7 gap-1" disabled title={t('underlay.backToPageUnsaved')} data-testid="sketch-underlay-back">
        {label}
      </Button>
    )
  }
  return (
    <Button size="sm" variant="ghost" className="h-7 gap-1" asChild data-testid="sketch-underlay-back">
      <Link href={pageReviewHref(projectId, underlay.ref.documentId, underlay.ref.page)}>{label}</Link>
    </Button>
  )
}

type Look = 'old' | 'new' | 'both'

export interface UnderlayMoveDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  documentId: string
  baseVersionId: string | null
  underlay: Extract<SketchUnderlayView, { state: 'available' }>
  onMoved: (versionNumber: number) => void
  /** The `/dev` preview's stand-ins for the two routes. */
  planOf?: (documentId: string, page?: number) => Promise<UnderlayMovePlan>
  move?: (documentId: string, baseVersionId: string | null, versionId: string, page?: number) => Promise<{ versionNumber: number }>
  rasterUrl?: typeof pageRasterUrl
}

export function UnderlayMoveDialog({
  open,
  onOpenChange,
  documentId,
  baseVersionId,
  underlay,
  onMoved,
  planOf = getUnderlayMovePlan,
  move = moveSketchUnderlay,
  rasterUrl = pageRasterUrl,
}: UnderlayMoveDialogProps) {
  const t = useTranslations(diagramsCopy)
  const [plan, setPlan] = useState<UnderlayMovePlan | null>(null)
  const [failure, setFailure] = useState<string | null>(null)
  const [look, setLook] = useState<Look>('both')
  const [busy, setBusy] = useState(false)
  // Two pages of the newer Fassung carry the old page's label: the person picks one, nothing guesses.
  const [choices, setChoices] = useState<number[]>([])
  const [chosen, setChosen] = useState<number | undefined>(undefined)

  useEffect(() => {
    if (!open) return
    const controller = new AbortController()
    setFailure(null)
    planOf(documentId, chosen).then(
      (answer) => !controller.signal.aborted && setPlan(answer),
      (error: unknown) => {
        if (controller.signal.aborted) return
        setPlan(null)
        if (error instanceof SketchRequestError && error.reason === 'label_ambiguous' && error.pages.length > 0) {
          setChoices(error.pages)
          setFailure(t('underlay.labelAmbiguous'))
          return
        }
        setFailure(error instanceof SketchRequestError && error.reason === 'page_gone' ? t('underlay.pageGone') : t('underlay.moveFailed'))
      }
    )
    return () => controller.abort()
  }, [open, documentId, planOf, chosen, t])

  const oldUrl = rasterUrl(underlay.ref)
  const newUrl = plan ? rasterUrl({ ...underlay.ref, versionId: plan.to.versionId, page: plan.to.page }) : null
  const doMove = async () => {
    if (!plan) return
    setBusy(true)
    try {
      onMoved((await move(documentId, baseVersionId, plan.to.versionId, plan.matchedBy === 'chosen' ? plan.to.page : undefined)).versionNumber)
    } catch {
      setFailure(t('underlay.moveFailed'))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-3xl" data-testid="sketch-underlay-move-dialog">
        <DialogHeader>
          <DialogTitle>{t('underlay.moveTitle', { number: String(underlay.newer?.versionNumber ?? '') })}</DialogTitle>
          <DialogDescription>{t('underlay.moveDescription')}</DialogDescription>
        </DialogHeader>
        {plan ? (
          <p className="text-sm" data-testid="sketch-underlay-plan">
            {plan.matchedBy === 'label'
              ? t('underlay.matchedByLabel', { label: plan.to.pageLabel ?? '', number: String(plan.to.versionNumber) })
              : plan.matchedBy === 'chosen'
                ? t('underlay.matchedByChoice', { page: String(plan.to.page), number: String(plan.to.versionNumber) })
                : plan.labelGone
                  ? t('underlay.matchedByIndexLabelGone', { label: plan.from.pageLabel ?? '', page: String(plan.to.page), number: String(plan.to.versionNumber) })
                  : t('underlay.matchedByIndex', { page: String(plan.to.page), number: String(plan.to.versionNumber) })}
          </p>
        ) : null}
        {choices.length > 0 ? (
          <ToggleGroup
            type="single"
            value={chosen ? String(chosen) : ''}
            onValueChange={(value) => value && setChosen(Number(value))}
            aria-label={t('underlay.labelAmbiguous')}
            data-testid="sketch-underlay-choices"
          >
            {choices.map((page) => (
              <ToggleGroupItem key={page} value={String(page)}>
                {t('underlay.choosePage', { page: String(page) })}
              </ToggleGroupItem>
            ))}
          </ToggleGroup>
        ) : null}
        <ToggleGroup type="single" value={look} onValueChange={(value) => value && setLook(value as Look)} segmented aria-label={t('underlay.moveTitle', { number: '' })}>
          <ToggleGroupItem value="old">{t('underlay.showOld')}</ToggleGroupItem>
          <ToggleGroupItem value="new">{t('underlay.showNew')}</ToggleGroupItem>
          <ToggleGroupItem value="both">{t('underlay.showBoth')}</ToggleGroupItem>
        </ToggleGroup>
        {/* Paper in both themes: the pages are drawings on white, never dark-filtered. */}
        <div className="border-border relative aspect-[1.414] w-full overflow-hidden rounded-md border bg-white" data-testid="sketch-underlay-compare">
          {look !== 'new' ? (
            // eslint-disable-next-line @next/next/no-img-element -- a private same-origin raster, not an optimizable asset
            <img src={oldUrl} alt={t('underlay.showOld')} className="absolute inset-0 size-full object-contain" />
          ) : null}
          {look !== 'old' && newUrl ? (
            // eslint-disable-next-line @next/next/no-img-element -- as above
            <img
              src={newUrl}
              alt={t('underlay.showNew')}
              className={look === 'both' ? 'absolute inset-0 size-full object-contain opacity-50 mix-blend-multiply' : 'absolute inset-0 size-full object-contain'}
            />
          ) : null}
        </div>
        {failure ? (
          <p className="text-destructive text-sm" role="alert">
            {failure}
          </p>
        ) : null}
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            {t('underlay.cancel')}
          </Button>
          <Button onClick={() => void doMove()} disabled={!plan || busy} data-testid="sketch-underlay-move-confirm">
            {t(busy ? 'underlay.moving' : 'underlay.move')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
