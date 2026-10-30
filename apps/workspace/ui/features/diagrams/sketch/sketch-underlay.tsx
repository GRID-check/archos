'use client'

/**
 * A Skizze traced over a PDF page, in the editor (S6, ADR-0150).
 *
 *   - {@link UnderlayBanner}: above the canvas, what the strokes lie on
 *     („Liegt auf Lageplan.pdf, Fassung 3, S. 2“) and the doctrine (nothing is
 *     measured on it); when the base has a newer Fassung, „liegt auf Fassung 3,
 *     aktuell 4“ and „Auf neue Fassung übertragen“.
 *   - {@link UnderlayMoveDialog}: the move, decided by a person, never on its
 *     own (research r2): the page it would land on (by its label, else its
 *     number), old and new shown alone or overlaid, and „Übertragen“, which
 *     saves the Skizze's next Fassung. Pins and links stay on their elements.
 *
 * Both pages come from the raster route with the reader's rights.
 */

import { Layers } from 'lucide-react'
import { useEffect, useState } from 'react'
import { getUnderlayMovePlan, moveSketchUnderlay, pageRasterUrl, SketchRequestError } from '@/adapters/api/diagrams-client'
import type { SketchUnderlayView, UnderlayMovePlan } from '@/lib/diagrams/sketch-underlay-wire'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { useTranslations } from '@/i18n'
import { diagramsCopy } from '@/i18n/namespaces/diagrams'

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
}

export function UnderlayBanner({ underlay, shown, documentId, baseVersionId, canMove, onMoved }: UnderlayBannerProps) {
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

type Look = 'old' | 'new' | 'both'

export interface UnderlayMoveDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  documentId: string
  baseVersionId: string | null
  underlay: Extract<SketchUnderlayView, { state: 'available' }>
  onMoved: (versionNumber: number) => void
  /** The `/dev` preview's stand-ins for the two routes. */
  planOf?: (documentId: string) => Promise<UnderlayMovePlan>
  move?: (documentId: string, baseVersionId: string | null, versionId: string) => Promise<{ versionNumber: number }>
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

  useEffect(() => {
    if (!open) return
    const controller = new AbortController()
    setFailure(null)
    planOf(documentId).then(
      (answer) => !controller.signal.aborted && setPlan(answer),
      (error: unknown) => {
        if (controller.signal.aborted) return
        setFailure(error instanceof SketchRequestError && error.reason === 'page_gone' ? t('underlay.pageGone') : t('underlay.moveFailed'))
      }
    )
    return () => controller.abort()
  }, [open, documentId, planOf, t])

  const oldUrl = rasterUrl(underlay.ref)
  const newUrl = plan ? rasterUrl({ ...underlay.ref, versionId: plan.to.versionId, page: plan.to.page }) : null
  const doMove = async () => {
    if (!plan) return
    setBusy(true)
    try {
      onMoved((await move(documentId, baseVersionId, plan.to.versionId)).versionNumber)
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
              : t('underlay.matchedByIndex', { page: String(plan.to.page), number: String(plan.to.versionNumber) })}
          </p>
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
