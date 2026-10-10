'use client'

/**
 * Two Fassungen of one document, looked at together.
 *
 * The question a reviewer brings is „what moved?", and a drawing answers it
 * better than a description: the wall is somewhere else, the door swings the
 * other way. Three ways to put the pages against each other, because none of
 * them is best for every change:
 *
 *  - **Nebeneinander**: two sheets that scroll and zoom as one, for reading each
 *    on its own terms. Stacks vertically below `md`.
 *  - **Überlagert**: the older sheet inked cyan, the newer orange, multiplied.
 *    What did not change lands on itself and goes near-black; what changed keeps
 *    its colour. The colour key lives under the sheet, only here, because only
 *    here do the colours mean something.
 *  - **Wischen**: a divider the reader drags across one sheet, older on the left,
 *    each side tagged on the sheet itself.
 *
 * Both pages are always drawn at ONE scale in a shared box. If each were fitted
 * to the width on its own, a smaller sheet would be stretched and every line
 * would appear to have moved.
 *
 * The changes (Piloti's boxes, or `overlays` another process found) are drawn
 * on the newer sheet and listed beside it, and the two are one thing: a single
 * `activeRegion` lights a box and its row together, from either side.
 *
 * The bytes come through `SourceLoader` (default: pdf.js and the preview
 * routes), which is also how the dev preview and the specs bring their own pages.
 */

import type { CSSProperties, JSX, KeyboardEvent } from 'react'
import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { MiddleTruncate } from '@/components/ui/middle-truncate'
import { distinguishingTailLength } from '@/lib/text/middle-truncate'
import { useIsMobile } from '@/hooks/use-is-mobile'
import { useMediaQuery } from '@/hooks/use-media-query'
import { useReducedMotion } from '@/hooks/use-reduced-motion'
import { useFassungVisualChanges } from '../../hooks/use-fassung-visual-changes'
import { useTranslations } from '@/i18n'
import { cn } from '@/lib/utils'
import { ChangeList } from './change-list'
import { StageBar, SwatchLabel } from './compare-atoms'
import { Stage, StageNotice, type Side } from './compare-stage'
import { MarkButton, ModeSwitch, PageNav, ZoomControl, type MarkState } from './compare-toolbar'
import { compareKeyAction, keyBelongsToTarget } from './lib/keys'
import { openPageSource } from './lib/page-source'
import {
  FIT_ZOOM,
  clampPage,
  commonStage,
  fitScale,
  hasPage,
  isFitZoom,
  nextZoom,
  pageSpan,
} from './lib/pages'
import {
  centeredScroll,
  groupByPage,
  mergeAnswers,
  numberRegions,
  regionsOnPage,
  type PageAnswer,
} from './lib/regions'
import { NEWER_INK, OLDER_INK, UNCHANGED_INK, paperVariables } from './lib/tint'
import { useActiveRegion } from './use-active-region'
import { usePageSize, usePageSource } from './use-page-sources'
import { useStageGestures } from './use-stage-gestures'
import type { CompareFile, CompareMode, CompareRegion, PageSize, SourceLoader } from './types'

export interface FassungCompareProps {
  older: CompareFile
  newer: CompareFile
  onClose: () => void
  /**
   * Changes already known (for example from an earlier run), drawn on the newer
   * sheet and listed beside it. A run the reader asks for here replaces them.
   */
  overlays?: readonly CompareRegion[]
  /** Where the pages come from. Defaults to the app's PDF and image renderers. */
  loadSource?: SourceLoader
  /** The mode the comparison opens in. */
  initialMode?: CompareMode
  /**
   * Open the text comparison of the same two Fassungen, for files that cannot
   * be compared as pictures. Without it, that state's action closes the dialog
   * back to the Fassung history, where the text comparison is.
   */
  onOpenTextCompare?: () => void
}

/** The height of a pane's caption row (`PaneCaption`). */
const PANE_LABEL = 28
/** The gap between two panes, side by side or stacked. */
const PANE_GAP = 12
/** Room around a sheet inside its scroll frame, each side. */
const FRAME_PADDING = 16
/** Where the change list moves from under the sheet to beside it. */
const WIDE_QUERY = '(min-width: 1024px)'

export function FassungCompare({
  older,
  newer,
  onClose,
  overlays = [],
  loadSource = openPageSource,
  initialMode = 'side',
  onOpenTextCompare,
}: FassungCompareProps): JSX.Element {
  const t = useTranslations('files')
  const stacked = useIsMobile()
  const wide = useMediaQuery(WIDE_QUERY)
  const reducedMotion = useReducedMotion()
  const descriptionId = useId()
  const keysId = useId()

  // Whatever had focus when the comparison opened gets it back on close. The
  // surfaces open this without a DialogTrigger, so Radix has nothing of its
  // own to return to.
  const [opener] = useState<HTMLElement | null>(() =>
    typeof document !== 'undefined' && document.activeElement instanceof HTMLElement ? document.activeElement : null,
  )
  useEffect(
    () => () => {
      window.setTimeout(() => {
        if (opener?.isConnected) opener.focus()
      }, 0)
    },
    [opener],
  )

  const [attempts, setAttempts] = useState({ older: 0, newer: 0 })
  const olderState = usePageSource(older, loadSource, attempts.older)
  const newerState = usePageSource(newer, loadSource, attempts.newer)

  const [mode, setMode] = useState<CompareMode>(initialMode)
  const [page, setPage] = useState(1)
  const [zoom, setZoom] = useState(FIT_ZOOM)
  const [opacity, setOpacity] = useState(100)
  const [divider, setDivider] = useState(50)
  const [area, setArea] = useState({ width: 0, height: 0 })

  const olderSource = olderState.status === 'ready' ? olderState.source : null
  const newerSource = newerState.status === 'ready' ? newerState.source : null
  const span = pageSpan(olderSource?.pageCount ?? 0, newerSource?.pageCount ?? 0)
  const current = clampPage(page, span.count)

  const olderSize = usePageSize(olderSource, current)
  const newerSize = usePageSize(newerSource, current)
  const stage = commonStage([olderSize, newerSize].filter((size): size is PageSize => size !== null))

  // Piloti's answers, per page, kept as they arrive: asking about page 2 adds
  // to page 1 instead of replacing it. The hook holds the last run; this folds
  // each finished run into the set (React's "adjust state while rendering").
  const visual = useFassungVisualChanges(newer.id, older.id)
  const [askedPage, setAskedPage] = useState<number | null>(null)
  const [answers, setAnswers] = useState<ReadonlyMap<number, PageAnswer>>(() => new Map())
  if (visual.state === 'done' && askedPage !== null) {
    const known = answers.get(askedPage)
    if (!known || known.regions !== visual.regions || known.summary !== visual.summary) {
      setAnswers(new Map(answers).set(askedPage, { regions: visual.regions, summary: visual.summary }))
    }
  }
  const shown = useMemo(() => (answers.size > 0 ? mergeAnswers(answers) : [...overlays]), [answers, overlays])
  const numbered = useMemo(() => numberRegions(shown), [shown])
  const groups = useMemo(
    () => groupByPage(numbered, new Map([...answers].map(([answered, answer]) => [answered, answer.summary]))),
    [numbered, answers],
  )
  const onPage = useMemo(() => regionsOnPage(numbered, current), [numbered, current])
  const activeRegion = useActiveRegion()

  const markPage = (target: number): void => {
    setAskedPage(target)
    void visual.run(target)
  }

  const contentRef = useRef<HTMLDivElement | null>(null)
  const areaRef = useRef<HTMLDivElement | null>(null)
  const blocked = olderState.status !== 'ready' || newerState.status !== 'ready'
  const settled = !blocked || [olderState.status, newerState.status].some((status) => status === 'failed' || status === 'not-comparable')
  const finalNotice = blocked && settled

  useEffect(() => {
    const node = areaRef.current
    if (!node || typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver((entries) => {
      const rect = entries[0]?.contentRect
      if (rect?.width) setArea({ width: rect.width, height: rect.height ?? 0 })
    })
    observer.observe(node)
    return () => observer.disconnect()
  }, [blocked])

  const sideBySide = mode === 'side' && !stacked
  const paneWidth = sideBySide ? (area.width - PANE_GAP) / 2 : area.width
  // Every view fits the whole sheet at „Einpassen". Stacked panes (a phone)
  // share the height, so each fits its half.
  const paneHeight =
    mode !== 'side' ? area.height : stacked ? (area.height - PANE_GAP) / 2 - PANE_LABEL : area.height - PANE_LABEL
  const scale = stage
    ? fitScale({ width: paneWidth - FRAME_PADDING * 2, height: paneHeight - FRAME_PADDING * 2 }, stage, zoom)
    : 0

  useStageGestures(areaRef, { enabled: !blocked, zoom, scale, onZoom: setZoom })

  const goToPage = useCallback((next: number) => setPage(clampPage(next, span.count)), [span.count])

  // „Show this change": pin it, turn to its page, and once its box is drawn,
  // scroll the newer sheet's frame so the box is in the middle. A ref, not
  // state, carries the request across the renders it may take (the page size
  // arrives asynchronously after a page turn).
  const reveal = useRef<number | null>(null)
  const [revealRequest, setRevealRequest] = useState(0)
  const showRegion = (number: number): void => {
    const entry = numbered.find((candidate) => candidate.number === number)
    activeRegion.pin(number)
    if (entry) goToPage(entry.region.page)
    reveal.current = number
    setRevealRequest((request) => request + 1)
  }
  useEffect(() => {
    const number = reveal.current
    if (number === null) return
    const box = areaRef.current?.querySelector<HTMLElement>(`[data-region="${number}"]`)
    const frame = box?.closest<HTMLElement>('[data-compare-frame]')
    if (!box || !frame) return
    reveal.current = null
    const rect = frame.getBoundingClientRect()
    const target = centeredScroll(
      {
        left: rect.left,
        top: rect.top,
        width: frame.clientWidth,
        height: frame.clientHeight,
        scrollLeft: frame.scrollLeft,
        scrollTop: frame.scrollTop,
        scrollWidth: frame.scrollWidth,
        scrollHeight: frame.scrollHeight,
      },
      box.getBoundingClientRect(),
    )
    if (typeof frame.scrollTo === 'function') {
      frame.scrollTo({ ...target, behavior: reducedMotion ? 'auto' : 'smooth' })
    }
  }, [revealRequest, current, scale, mode, newerSize, reducedMotion])

  // A final notice (failed, not comparable) unmounts the toolbar that held
  // focus; hand it to the notice's action rather than to <body>.
  useEffect(() => {
    if (!finalNotice) return
    const content = contentRef.current
    if (!content || (content.contains(document.activeElement) && document.activeElement !== content)) return
    content.querySelector<HTMLElement>('[data-compare-notice-action]')?.focus()
  }, [finalNotice])

  const onKeyDown = (event: KeyboardEvent<HTMLElement>): void => {
    if (keyBelongsToTarget(event.key, event.target)) return
    const action = compareKeyAction(event)
    if (!action) return
    event.preventDefault()
    if (action.type === 'mode') setMode(action.mode)
    else if (action.type === 'edge') goToPage(action.edge === 'first' ? 1 : span.count)
    else goToPage(current + action.delta)
  }

  const sides: { older: Side; newer: Side } = {
    older: { file: older, source: olderSource, size: olderSize },
    newer: { file: newer, source: newerSource, size: newerSize },
  }

  const canMark = hasPage(olderSource?.pageCount ?? 0, current) && hasPage(newerSource?.pageCount ?? 0, current)
  const markState: MarkState =
    visual.state === 'loading' && askedPage !== null
      ? { kind: 'loading', page: askedPage }
      : answers.has(current)
        ? { kind: 'done', page: current }
        : canMark
          ? { kind: 'ready', page: current }
          : { kind: 'missing', page: current }
  const markButton = <MarkButton state={markState} onMark={() => markPage(current)} className={wide ? undefined : 'w-full'} />
  // A refusal belongs to the page it was asked for; turning the page leaves it behind.
  const markError =
    visual.state === 'error' && askedPage === current
      ? { message: t(markErrorKey(visual.errorStatus)), retryable: visual.errorStatus !== 409 }
      : null
  const loadingPage = visual.state === 'loading' ? askedPage : null
  // On a wide screen the list opens beside the sheet only once it has
  // something to say; before a run the button sits in the toolbar and the
  // sheets keep the width.
  const panelOpen = !wide || numbered.length > 0 || groups.length > 0 || loadingPage !== null || markError !== null

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent
        closeLabel={t('compare.close')}
        data-testid="fassung-compare"
        aria-describedby={`${descriptionId} ${keysId}`}
        onKeyDown={onKeyDown}
        ref={contentRef}
        // The dialog is a surface, not a control, so it wears no ring (the
        // global `:focus-visible` rule is unlayered and beats a utility class).
        style={{ outline: 'none', ...(paperVariables() as CSSProperties) }}
        onOpenAutoFocus={(event) => {
          // Land on the view switch: a visible control, and one that leaves the
          // arrows to turn the page from the first key press.
          event.preventDefault()
          const content = contentRef.current
          const target =
            content?.querySelector<HTMLElement>('[data-testid^="mode-"][data-state="on"]') ??
            content?.querySelector<HTMLElement>('[data-compare-notice-action]') ??
            content
          target?.focus()
        }}
        onCloseAutoFocus={(event) => {
          event.preventDefault()
          if (opener?.isConnected) opener.focus()
        }}
        className="top-0 left-0 h-dvh max-h-dvh w-screen max-w-none translate-x-0 translate-y-0 grid-rows-[auto_auto_minmax(0,1fr)] gap-0 overflow-hidden p-0 max-sm:rounded-none max-sm:border-0 sm:top-4 sm:left-4 sm:h-[calc(100dvh-2rem)] sm:max-h-[calc(100dvh-2rem)] sm:w-[calc(100vw-2rem)] sm:max-w-none sm:translate-x-0 sm:translate-y-0"
      >
        <DialogHeader className="gap-1 border-b px-4 py-3 pr-14 text-left">
          <DialogTitle className="text-base">{t('compare.title')}</DialogTitle>
          <DialogDescription id={descriptionId} className="flex min-w-0 flex-col gap-x-5 gap-y-0.5 sm:flex-row" data-testid="compare-names">
            <FileName label={t('compare.olderLabel')} name={older.filename} tail={distinguishingTailLength(older.filename, newer.filename)} />
            <FileName label={t('compare.newerLabel')} name={newer.filename} tail={distinguishingTailLength(newer.filename, older.filename)} />
          </DialogDescription>
          <p id={keysId} className="sr-only">
            {t('compare.keysHint')}
          </p>
        </DialogHeader>

        {finalNotice ? (
          <div />
        ) : (
          <div className="space-y-1.5 border-b px-4 py-2" data-testid="compare-toolbar">
            <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
              <ModeSwitch mode={mode} onMode={setMode} />
              <div className="flex items-center gap-x-3 max-sm:w-full max-sm:justify-between">
                {!blocked && span.count > 1 && <PageNav current={current} count={span.count} onPage={goToPage} />}
                <ZoomControl
                  zoom={zoom}
                  disabled={blocked}
                  onStep={(direction) => setZoom((value) => nextZoom(value, direction))}
                  onFit={() => setZoom(FIT_ZOOM)}
                />
              </div>
              {wide && !blocked && <div className="ml-auto">{markButton}</div>}
            </div>
            {!blocked && span.differs && (
              <p className="text-warning text-xs" role="status" data-testid="compare-page-count-note">
                {t('compare.pageCountDiffers', {
                  older: olderSource?.pageCount ?? 0,
                  newer: newerSource?.pageCount ?? 0,
                })}
              </p>
            )}
          </div>
        )}

        <div className="flex min-h-0 flex-col lg:flex-row">
          <div className="flex min-h-0 min-w-0 flex-1 flex-col" data-testid="compare-area">
            <div ref={areaRef} className="min-h-0 flex-1">
              {blocked ? (
                <StageNotice
                  older={olderState.status}
                  newer={newerState.status}
                  olderName={older.filename}
                  newerName={newer.filename}
                  onRetry={() =>
                    setAttempts((tries) => ({
                      older: tries.older + (olderState.status === 'failed' ? 1 : 0),
                      newer: tries.newer + (newerState.status === 'failed' ? 1 : 0),
                    }))
                  }
                  onTextCompare={onOpenTextCompare ?? onClose}
                  hasTextCompare={onOpenTextCompare !== undefined}
                />
              ) : (
                <Stage
                  mode={mode}
                  sides={sides}
                  page={current}
                  stage={stage}
                  scale={scale}
                  opacity={opacity}
                  divider={divider}
                  onDividerChange={setDivider}
                  regions={onPage}
                  activeRegion={activeRegion}
                  pannable={!isFitZoom(zoom) && zoom > FIT_ZOOM}
                />
              )}
            </div>
            {!blocked && (
              <StageBar className={cn(mode !== 'overlay' && 'max-md:hidden')}>
                {mode === 'overlay' && (
                  <>
                    <ul className="flex flex-wrap items-center gap-x-4 gap-y-1" aria-label={t('compare.legendLabel')} data-testid="compare-legend">
                      <SwatchLabel ink={OLDER_INK} title={older.filename}>
                        {t('compare.legendOlder')}
                      </SwatchLabel>
                      <SwatchLabel ink={NEWER_INK} title={newer.filename}>
                        {t('compare.legendNewer')}
                      </SwatchLabel>
                      <SwatchLabel ink={UNCHANGED_INK}>{t('compare.legendUnchanged')}</SwatchLabel>
                    </ul>
                    <label className="flex items-center gap-2">
                      {/* Named on screen where the bar has room for it; below that the slider keeps its name for a screen reader, and the bar stays one line. */}
                      <span className="text-muted-foreground max-xl:sr-only max-md:not-sr-only">{t('compare.opacity')}</span>
                      <input
                        type="range"
                        min={0}
                        max={100}
                        step={5}
                        value={opacity}
                        aria-valuetext={t('compare.opacityValue', { percent: opacity })}
                        data-testid="compare-opacity"
                        className="accent-foreground w-28 pointer-coarse:h-11"
                        onChange={(event) => setOpacity(Number(event.target.value))}
                      />
                      <span className="w-11 text-right tabular-nums" aria-hidden>
                        {t('compare.opacityValue', { percent: opacity })}
                      </span>
                    </label>
                  </>
                )}
                {mode !== 'overlay' && (
                  // The overlay's key and fader take the bar; there the mode chips' digits and the tooltips carry the keys.
                  <span className="text-muted-foreground ml-auto hidden text-xs md:inline pointer-coarse:hidden" aria-hidden>
                    {t('compare.keysHintVisible')}
                  </span>
                )}
              </StageBar>
            )}
          </div>
          {!finalNotice && !blocked && panelOpen && (
            <ChangeList
              groups={groups}
              current={current}
              activeRegion={activeRegion}
              onShow={showRegion}
              loadingPage={loadingPage}
              error={markError}
              onRetry={() => askedPage !== null && markPage(askedPage)}
              action={wide ? undefined : markButton}
              className="max-h-48 shrink-0 border-t sm:max-h-56 lg:max-h-none lg:w-80 lg:border-t-0 lg:border-l"
            />
          )}
        </div>
      </DialogContent>
    </Dialog>
  )
}

/** One labelled file name in the header, cut in the middle so its index survives. */
function FileName({ label, name, tail }: { label: string; name: string; tail: number }): JSX.Element {
  return (
    <span className="flex min-w-0 items-baseline gap-1.5">
      <span className="text-muted-foreground shrink-0 text-xs">{label}</span>
      <MiddleTruncate text={name} tail={tail} className="text-foreground text-sm" />
    </span>
  )
}

/** The refusal's status as copy: 409 not read yet, 502/503 not reachable, anything else a plain failure. */
function markErrorKey(status: number | null): 'compare.markNotRead' | 'compare.markUnavailable' | 'compare.markFailed' {
  if (status === 409) return 'compare.markNotRead'
  if (status === 502 || status === 503) return 'compare.markUnavailable'
  return 'compare.markFailed'
}
