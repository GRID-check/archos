

import { Check, Link2, MonitorX, MoreHorizontal, TriangleAlert, X } from 'lucide-react'
import { Button } from '@/components/ui/button'

import { cn } from '@/lib/utils'

import { DocumentActionsMenu } from '@/features/documents/components/document-actions'
import { ModelFileOwnership } from './model-file-ownership'

import { measurementText } from '../lib/measure-overlay'

import { ViewerIconButton, ViewerIconButtonBase, ViewerLegend, ViewerRail, ViewerSurface } from './viewer'
import { DOCK_ABOVE_OFFSET } from './model-stage-helpers'
import { StageCanvas } from './stage-canvas'
import type { ModelStageController } from './use-model-stage-controller'
import type { ModelMarks } from '../hooks/use-model-marks'

export function ModelStageCanvasLayer({ controller, marks }: { controller: ModelStageController; marks: ModelMarks }) {
  const { error, isLoading, measureLabels, model, models, newestMeasurement, onClose, reloadModels, source, stageAnnouncement, viewport } = controller
  return (
    <>
          {/*
            The one thing the viewport says out loud.

            Nothing in this feature was a live region — verified by grep — so
            a forty-second load, its arrival, a renderer that died, a copied
            link and a capture that failed were all silent. A screen-reader
            user could not tell a slow load from a failed one, and the two
            transient confirmations were carried ONLY by a swapped icon and a
            changed button name, neither of which any AT announces.

            One node rather than several, `polite` rather than `assertive`:
            these are reports, not interruptions, and a viewport that
            interrupts on every phase change is worse than one that is quiet.
          */}
          <p className="sr-only" role="status" aria-live="polite">
            {stageAnnouncement}
          </p>
          {/*
            The dimension just taken, on its own channel.
            A measurement is not a status change — it is the RESULT of the
            reader's action, and it must not have to queue behind "Modell
            geladen" or be lost when a copy confirmation overwrites the region
            a moment later. Always mounted and empty until there is one, for
            the same reason as the region above: a live region inserted with
            text already in it is not announced at all.
          */}
          <p className="sr-only" role="status" aria-live="polite">
            {newestMeasurement ? measurementText(newestMeasurement, measureLabels) : ''}
          </p>
          <StageCanvas
            isLoading={isLoading}
            error={error}
            onRetry={reloadModels}
            onClose={onClose}
            hasModels={(models?.length ?? 0) > 0}
            model={model}
            source={source}
            viewport={viewport}
            bridge={marks.bridge}
            canvasOverride={marks.canvasOverride}
          />

    </>
  )
}

export function ModelStageChromeLayer({ controller }: { controller: ModelStageController }) {
  const { advancedOpen, canCollaborate, compact, compactSheet, copied, copyFailed, copyLink, dockAboveRows, layout, legendEntries, model, onClose, onModelDeleted, onModelRenamed, projectId, railHasContent, railOpen, railSections, reloadElements, renderInspector, selectedGlobalId, stageWarning, t } = controller
  return (
    <>
          {/* Rail — models and levels. */}
          {railOpen && railHasContent && (
            <div className="absolute top-3 left-3 z-20 flex max-h-[calc(100%-1.5rem)] sm:top-4 sm:left-4">
              <ViewerRail>{railSections}
              </ViewerRail>
            </div>
          )}

          {/*
            The way out, and the way to share what is on screen. Above
            everything — the analytical drawer is z-30 and starts at the same
            corner, so at a lower layer this pill would be buried under it and
            the only way to close the model would be Escape.
          */}
          <div className="absolute top-3 right-3 z-40 sm:top-4 sm:right-4">
            <ViewerSurface className="flex items-center gap-1 p-1">
              {/*
                The name does not change on SUCCESS. It used to, and the live
                region says the same words at the same moment — an accessible
                name changing on the focused element is announced too, so
                "Link kopiert" arrived twice. The check icon is the visual
                confirmation and the region is the spoken one.

                A FAILURE still swaps the name. It is the rarer event and the
                one a reader has to be able to discover on hover, so the
                redundancy is worth what it costs there.
              */}
              {/*
                The file operations, on the building.

                A model is a document like any other, and until now it was the
                one document in the product you could not rename or delete
                where you were looking at it — you had to close the viewer,
                find the card again, and open a different surface. The menu is
                the same one the file preview carries; only its trigger is
                dressed for the viewport.
              */}
              {/* Collaboration is per-project by definition — there is nobody
                  to be responsible for an org-wide Archiv file on behalf of a
                  project that was never named. */}
              {model && projectId && (
                <ModelFileOwnership
                  projectId={projectId}
                  model={model}
                  canCollaborate={canCollaborate}
                />
              )}
              {model && (
                <DocumentActionsMenu
                  document={{
                    id: model.documentId,
                    filename: model.filename,
                    displayName: model.displayName,
                  }}
                  // The rail lists the project's models AND the org-wide
                  // Archiv's (`listAccessibleModels` includes both, because
                  // retrieval does). An Archiv model has no project, and its
                  // delete goes to the org-scoped route — the project one
                  // answers 404 for it on purpose.
                  scope={model.projectId === null ? 'officeShelf' : 'files'}
                  onRenamed={onModelRenamed}
                  onDeleted={(documentId) => {
                    onModelDeleted?.(documentId)
                    // The building on screen no longer exists. Staying open on
                    // a viewport of nothing is not a state worth offering.
                    onClose()
                  }}
                  align="end"
                  trigger={
                    <ViewerIconButtonBase
                      label={t('stage.fileActions')}
                      icon={MoreHorizontal}
                      data-testid="stage-file-actions"
                    />
                  }
                />
              )}
              <ViewerIconButton
                label={copyFailed ? t('link.failed') : t('link.copy')}
                icon={copyFailed ? MonitorX : copied ? Check : Link2}
                onClick={copyLink}
                side="bottom"
              />
              <ViewerIconButton
                label={t('stage.close')}
                icon={X}
                onClick={onClose}
                side="bottom"
                data-testid="stage-close"
              />
            </ViewerSurface>
          </div>

          {/* Selection — and nothing at all until there is one. */}
          {!compact && selectedGlobalId && (
            <div
              className={cn(
                'absolute top-3 right-3 z-20 flex max-h-[calc(100%-1.5rem)] pt-12 sm:top-4 sm:right-4',
                // Steps aside for the advanced drawer rather than hiding under
                // it: clicking a wall while the Prüfbuch is open is exactly
                // when you want both. Below `sm` there is nowhere to step —
                // the drawer is `calc(100% - 1.5rem)` wide — so the card
                // yields instead of rendering invisibly behind it. That is
                // the state the drawer's own "show elements" action produces.
                advancedOpen && 'max-sm:hidden sm:right-[28rem]'
              )}
            >
              {renderInspector()}
            </div>
          )}

          {/*
            A phone on its side has no height for a bottom sheet, so the same
            sheet is a panel at the right edge, under the file/close pill. A
            portrait phone's sheet is not here at all: it sits in the dock's
            own column (`sheet` below), where it cannot overlap the cut slider
            or the legend by arithmetic.
          */}
          {layout === 'phone-landscape' && compactSheet && (
            <div className="absolute top-[4.75rem] right-3 bottom-3 z-20 flex">{compactSheet}</div>
          )}

          {/*
            Two things the reader has to know about a link they followed, and
            neither was said anywhere. `unresolved` is documented in
            `model-index.ts` as "not a diagnostic detail — it is shown", and
            it was shown only by the chat card: click through to the full
            screen and the warning disappeared while the legend quietly
            counted fewer elements than the answer named.
          */}
          {stageWarning && (
            <div className="absolute top-16 left-1/2 z-20 -translate-x-1/2 animate-in fade-in-0 duration-base ease-out motion-reduce:animate-none sm:top-20">
              <ViewerSurface className="flex items-start gap-2 px-3 py-2 text-xs">
                <TriangleAlert className="text-warning mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
                {/*
                  Clamped to the viewport, not only to 28rem. Centred on
                  `left-1/2` with a 448 px cap, the pill measured about 490 px
                  with its icon and padding — some 50 px off each side of a
                  390 px phone, unscrollable, on the one sentence that says the
                  view is not the view that was sent.
                */}
                <span className="max-w-[min(28rem,calc(100vw-6rem))]">{stageWarning.text}</span>
                {/*
                  The one warning here that has something to press — and only
                  when that is the warning being shown. Keyed off the message
                  rather than off `elementsError` directly, because a capture
                  that fails while the element walk is also broken would
                  otherwise put "try again" next to a sentence about a
                  screenshot, wired to reload something else.
                */}
                {stageWarning.retry && (
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    className="-my-1 h-6 shrink-0 px-2 text-xs"
                    onClick={reloadElements}
                  >
                    {t('loadFailed.action')}
                  </Button>
                )}
              </ViewerSurface>
            </div>
          )}

          {/* What the colours mean, when something coloured them. */}
          {!compact && (
            <ViewerLegend
              className={cn(
                'absolute left-3 z-20 sm:left-4',
                /*
                  Pinned above the dock — including whatever the dock has stacked
                  on top of itself. At a fixed `bottom-20` the legend sat exactly
                  where the section slider lands: same `z-20`, legend painted
                  first, so the slider covered it. That is not an exotic state,
                  it is what a compliance deep link produces — highlights (so a
                  legend) plus a cut. Widths do not save it either; the slider is
                  `max-w-full` on a phone.
                */
                DOCK_ABOVE_OFFSET[dockAboveRows]
              )}
              entries={legendEntries}
            />
          )}

    </>
  )
}
