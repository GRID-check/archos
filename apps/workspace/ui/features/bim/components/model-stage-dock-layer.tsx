

import { Camera, Eye, Home, Layers, MonitorX, PanelLeft, Ruler, Scissors, SlidersHorizontal, Undo2 } from 'lucide-react'
import { Button } from '@/components/ui/button'

import { cn } from '@/lib/utils'

import { type BimModelTab } from '../lib/model-link'

import { formatMetresIn } from '../lib/format-value'
import { measurementText } from '../lib/measure-overlay'

import { ModelAdvancedSheet } from './model-advanced-sheet'
import { PhoneTools } from './stage-phone-chrome'
import { StageViewMenu } from './stage-view-menu'
import { ViewerDock, ViewerDockSeparator, ViewerIconButton, ViewerLegend, ViewerSlider, ViewerSurface } from './viewer'

import type { ModelStageController } from './use-model-stage-controller'

export function ModelStageDockLayer({ controller }: { controller: ModelStageController }) {
  const { advancedOpen, advancedToggleRef, captureFailed, closeAdvanced, coarsePointer, compact, compactSheet, cutDefault, elementList, elementsError, elementsLoading, focusViewport, goBack, handleSelect, history, layout, legendEntries, locale, measureLabels, model, modelId, models, phoneSheet, projectId, railHasContent, railOpen, reloadElements, section, selectedGlobalId, setAdvancedOpen, setRailChoice, setView, storey, t, togglePhoneSheet, view, viewport, xrayNeedsTarget } = controller
  return (
    <>
          <ViewerDock
            // The drawer is `z-30` and right-anchored full height; the dock is
            // `z-20` and centred. On a 1024 px viewport the drawer sat on top
            // of x-ray, the rail toggle and the button that OPENED it — press
            // the visibly-pressed button again and nothing happened, because
            // the drawer was intercepting the click. On a phone it covered
            // every viewer control. The inspector was taught to step aside;
            // the dock never was.
            //
            // Below `sm` the drawer is effectively full-screen, so there is no
            // padding that helps: the dock yields entirely rather than
            // presenting nine glyphs that cannot be pressed. Escape and the
            // drawer's own X are the ways back, and both restore focus here.
            className={cn(advancedOpen && 'max-sm:hidden sm:pr-[27rem]')}
            layout={layout === 'phone' ? 'bar' : layout === 'phone-landscape' ? 'side' : 'floating'}
            sheet={layout === 'phone' ? compactSheet : undefined}
            lead={
              compact ? undefined : (
              <>
                {/*
                  In the leading pill, beside Home, because both answer the
                  same question — "get me back" — and neither is a tool for
                  looking at the building. Home undoes the CAMERA; this undoes
                  the last thing the reader changed, whether that was the view
                  or what they took out of the way. Keeping them together is
                  what makes the pair legible: one returns the eye, the other
                  returns the state.
                */}
                <ViewerIconButton
                  label={t('stage.back')}
                  icon={Undo2}
                  onClick={goBack}
                  disabled={history.length === 0}
                />
                <ViewerIconButton
                  label={t('stage.home')}
                  icon={Home}
                  onClick={viewport.fit}
                  disabled={viewport.status.phase !== 'ready'}
                />
              </>
              )
            }
            above={
              <>
                {/*
                  On a phone the legend is a row of the stack, not a corner
                  card positioned against the dock's height by hand: the slider,
                  the measuring strip and the sheet all appear and disappear,
                  and a stack cannot overlap by arithmetic.
                */}
                {compact && <ViewerLegend className="self-start" entries={legendEntries} />}
                {/*
                  What to click next, and a way out of the measurements once
                  they have been read. A measure tool with no running commentary
                  is a crosshair the reader has to experiment with — and one
                  with no way to clear leaves the building covered in someone
                  else's arithmetic.
                */}
                {/*
                  Rendered while the tool is on OR while anything is measured.
                  Turning the tool off keeps the measurements on screen by
                  design — and used to take away the only control that could
                  clear them, leaving the building covered in someone else's
                  arithmetic with no way out.
                */}
                {(viewport.measure.active || viewport.measure.measurements.length > 0) && (
                  <ViewerSurface className="pointer-events-auto flex items-center gap-2 px-3 py-1.5">
                    {viewport.measure.active && (
                      <span className="text-muted-foreground text-xs">
                        {t(
                          viewport.measure.pending
                            ? coarsePointer
                              ? 'viewer.measure.secondTouch'
                              : 'viewer.measure.second'
                            : coarsePointer
                              ? 'viewer.measure.firstTouch'
                              : 'viewer.measure.first'
                        )}
                      </span>
                    )}
                    {viewport.measure.measurements.length > 0 && (
                      <>
                        {/*
                          The numbers themselves, for a reader who cannot see
                          the drawing over the model. The overlay is marked
                          decorative precisely because this exists: without it
                          every dimension the tool produced was available
                          nowhere but as pixels.
                        */}
                        {/*
                          Not a live region — the one at the top of the dialog
                          announces the newest measurement. This is the full
                          list, browsable, for a reader going back over what
                          they took. It used to be the `role="status"`, which
                          made it announce every dimension again each time a
                          new one was added, and never announce the first.
                        */}
                        <span className="sr-only">
                          {viewport.measure.measurements
                            .map((measurement) => measurementText(measurement, measureLabels))
                            .join('; ')}
                        </span>
                        <span className="text-muted-foreground text-xs tabular-nums">
                          {viewport.measure.measurements.length === 1
                            ? t('viewer.measure.countOne')
                            : t('viewer.measure.count', {
                                count: viewport.measure.measurements.length,
                              })}
                        </span>
                        <Button
                          type="button"
                          size="sm"
                          variant="ghost"
                          className="h-7 px-2 text-xs"
                          onClick={() => {
                            viewport.measure.clear()
                            // The pill this button sits in goes with the list
                            // when the tool is already off.
                            focusViewport()
                          }}
                        >
                          {t('viewer.measure.clear')}
                        </Button>
                      </>
                    )}
                  </ViewerSurface>
                )}
                {section && viewport.bounds && (
                <ViewerSlider
                  label={t('viewer.section.height')}
                  min={viewport.bounds.minMetres}
                  max={viewport.bounds.maxMetres}
                  value={section.atMetres}
                  display={t('viewer.section.metres', { value: formatMetresIn(section.atMetres, locale) })}
                  // Per step: move the plane, now. Per gesture: write the
                  // link. Both were the second one, which is why the slider
                  // could not be dragged at all — see `viewer-slider.tsx`.
                  onChange={viewport.previewCut}
                  onCommit={(atMetres) => viewport.setSection({ ...section, atMetres })}
                  action={
                    <Button
                      type="button"
                      size="sm"
                      variant="ghost"
                      className="h-7 px-2 text-xs"
                      aria-pressed={section.flipped}
                      onClick={() => viewport.setSection({ ...section, flipped: !section.flipped })}
                    >
                      {t(section.flipped ? 'viewer.section.up' : 'viewer.section.down')}
                    </Button>
                  }
                />
                )}
              </>
            }
            trail={
              <>
                {/*
                  The reset — not the undo, which is Undo, in the leading pill
                  and one step at a time. This one clears every hide and every
                  isolation at once, which is what someone wants after eight
                  of them and never after one.

                  It appears only once something is out of the way, because a
                  viewport nobody has edited has nothing to restore — and a
                  permanently-visible reset is a control that is wrong about
                  the state it describes most of the time.
                */}
                {viewport.visibility.edited && (
                  <ViewerIconButton
                    label={t('stage.showEverything')}
                    icon={Layers}
                    onClick={() => {
                      viewport.visibility.showEverything()
                      // This button exists only while something is hidden, so
                      // pressing it deletes it. Its disappearance is also the
                      // only confirmation that anything happened — losing the
                      // reader's place on top of that leaves them with no
                      // signal at all.
                      focusViewport()
                    }}
                  />
                )}
                {/*
                  The rail holds the model list and the level list, and both
                  can be absent — one model, and an export whose storeys have
                  no names. It then rendered as a 13 rem empty blurred pill
                  over the building, with a dock toggle reporting `active` for
                  it. A toggle for nothing is not a toggle.
                */}
                <ViewerIconButton
                  label={railOpen ? t('stage.rail.hide') : t('stage.rail.show')}
                  icon={PanelLeft}
                  active={railOpen && railHasContent}
                  disabled={!railHasContent}
                  onClick={() => setRailChoice(!railOpen)}
                />
                <ViewerIconButton
                  ref={advancedToggleRef}
                  label={t('stage.advanced')}
                  icon={SlidersHorizontal}
                  active={advancedOpen}
                  onClick={() => setAdvancedOpen(!advancedOpen)}
                  disabled={!modelId}
                />
              </>
            }
          >
            {compact ? (
              <PhoneTools
                placement={layout === 'phone-landscape' ? 'side' : 'bar'}
                ready={viewport.status.phase === 'ready'}
                onFit={viewport.fit}
                cameraView={viewport.camera.view}
                orthographic={viewport.camera.orthographic}
                onViewChange={viewport.setView}
                onOrthographicChange={viewport.setOrthographic}
                sectionOn={section !== null}
                onToggleSection={() =>
                  viewport.setSection(section ? null : { atMetres: cutDefault, flipped: false })
                }
                measuring={viewport.measure.active}
                onToggleMeasure={() => viewport.measure.setActive(!viewport.measure.active)}
                hasLevels={railHasContent}
                sheet={phoneSheet}
                onToggleSheet={togglePhoneSheet}
                edited={viewport.visibility.edited}
              />
            ) : (
              <>
            <StageViewMenu
              view={viewport.camera.view}
              orthographic={viewport.camera.orthographic}
              onViewChange={viewport.setView}
              onOrthographicChange={viewport.setOrthographic}
              disabled={viewport.status.phase !== 'ready'}
            />
            <ViewerDockSeparator />
            <ViewerIconButton
              label={t('viewer.section.toggle')}
              icon={Scissors}
              active={section !== null}
              disabled={viewport.status.phase !== 'ready'}
              onClick={() =>
                viewport.setSection(section ? null : { atMetres: cutDefault, flipped: false })
              }
            />
            <ViewerIconButton
              label={captureFailed ? t('viewer.capture.failed') : t('viewer.capture.action')}
              icon={captureFailed ? MonitorX : Camera}
              disabled={viewport.status.phase !== 'ready'}
              onClick={viewport.capture}
            />
            <ViewerIconButton
              label={t('viewer.measure.toggle')}
              icon={Ruler}
              active={viewport.measure.active}
              disabled={viewport.status.phase !== 'ready'}
              onClick={() => viewport.measure.setActive(!viewport.measure.active)}
            />
            {/*
              See-through ghosts everything that is NOT highlighted or
              selected, so with neither there is nothing to keep solid and the
              renderer is correctly told to ghost nothing. Pressing it wrote
              `xray=1`, filled the button and set `aria-pressed` — and the
              building did not change. A control that cannot act must not
              offer to; this is the second time this particular button has
              been pressed-and-inert, for a different reason each time.
            */}
            <ViewerIconButton
              // The name says WHY when it cannot act. A disabled control gets
              // no tooltip — Radix's trigger never fires on a disabled button
              // — so the reason documented in the comment above reached
              // nobody: the reader was left with an inert eye and no way to
              // discover that selecting a wall would turn it on.
              label={xrayNeedsTarget ? t('viewer.xrayNeedsTarget') : t('viewer.xray')}
              icon={Eye}
              active={view.xray ?? false}
              disabled={viewport.status.phase !== 'ready' || xrayNeedsTarget}
              onClick={() => setView({ xray: !(view.xray ?? false) })}
            />
              </>
            )}
          </ViewerDock>

          {/*
            The analytical surfaces — Prüfbuch, Raumbuch, Mengen, Revisionen.
            Real work, and none of it is what someone opening a model came to
            do, so it lives behind one button and arrives as a drawer over the
            building rather than as five tabs in front of it.
          */}
          {modelId && model && (
            <ModelAdvancedSheet
              open={advancedOpen}
              // Back to the button that opened it. The drawer's X unmounts
              // itself, so without this closing a panel put the reader at the
              // top of the dialog instead of back on the toolbar.
              onClose={closeAdvanced}
              projectId={projectId}
              model={model}
              models={models ?? []}
              elements={elementList}
              // The Struktur tab reads an empty array as a building with no
              // elements and blames a filter the reader never set — see
              // `IfcElementTable`. The stage has known which of the three
              // situations it is in all along; it just never said.
              elementsLoading={elementsLoading}
              elementsError={elementsError !== null}
              onReloadElements={reloadElements}
              tab={view.tab ?? 'overview'}
              onTabChange={(tab: BimModelTab) => setView({ tab })}
              storey={storey}
              onSelectStorey={(next) => setView({ storey: next ?? undefined, element: undefined })}
              selectedGlobalId={selectedGlobalId}
              onSelectElement={handleSelect}
              // A finding becomes a VIEW: the offending elements are
              // highlighted, the first is selected, and the URL now points at
              // exactly that — so "here is the problem" is a link.
              onShowElements={(globalIds, status = 'fail') =>
                setView({
                  element: globalIds[0],
                  highlights: [{ status, globalIds }],
                  xray: true,
                })
              }
              onOpenModel={(filename) =>
                setView({
                  model: filename,
                  element: undefined,
                  highlights: undefined,
                  xray: undefined,
                })
              }
            />
          )}
    </>
  )
}
