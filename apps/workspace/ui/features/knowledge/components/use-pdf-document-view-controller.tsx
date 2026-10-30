import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from 'react'
import type { PDFDocumentProxy } from 'pdfjs-dist'

import { InsetStage } from '@/components/ui/inset-stage'

import { capturePosthog } from '@/lib/analytics/posthog'
import { useTranslations } from '@/i18n'
import { knowledgeCopy } from '@/i18n/namespaces/knowledge'
import { useMediaQuery } from '@/hooks/use-media-query'

import { documentParameters, loadPdfjs, readPageTextItems } from '../lib/pdfjs-runtime'
import { pageTextChunks } from '../lib/pdf-text-chunks'
import { canvasMeasure } from '../lib/canvas-measure'
import type { PageRegion } from '../lib/page-region'
import { buildPassageIndex, findOccurrences, MIN_SEARCH_QUERY, normalizePassage, passageBounds, type HighlightRect, type PassageIndex } from '../lib/passage-highlight'
import { anchoredTransform, clampPage, clampZoom, fitWidth, maxZoomFor, stepZoom, viewerKeyAction, type FitMode } from '../lib/pdf-zoom'

import { ContentTransform } from '../lib/content-transform'
import { useZoomGestures, type ZoomCommit } from '../lib/use-zoom-gestures'

import { MAX_SEARCH_RADIUS, searchRadius, pagesWithin, PLACEHOLDER_PAGE_ASPECT, GUTTER, TOUCH_GUTTER, PASSAGE_SCROLL_OFFSET, DETAIL_SETTLE_MS, CURRENT_PAGE_BAND, COPIED_FEEDBACK_MS, MIN_QUOTE_LENGTH, PassageHit, QuoteSelection, FIT_PAGE_PADDING, RERASTER_DELAY_MS, SEARCH_DEBOUNCE_MS, ANNOUNCE_DELAY_MS, SearchHit, ZoomAnchor, createViewSignal, prefersReducedMotion, LoadState, passwordState, scrollBehavior, pageShare } from './pdf-document-view-helpers'
import { HostGround } from './pdf-document-view-chrome'

export interface PdfDocumentViewProps {
  /** URL the document streams from (corpus route or presigned object store). */
  src: string
  title: string
  /** 1-based page to open at. */
  page?: number | null
  /** Cited passage to find on `page` and light up. */
  highlight?: string | null
  /**
   * CSS colour for the mark, so it matches the chip that opened the viewer.
   * A plain colour rather than a source-tint enum keeps this component free of
   * the chat feature's vocabulary.
   */
  highlightColor?: string
  /**
   * Boxes on `page` to mark, for a passage read off a picture of the page — a
   * plan's depiction — rather than out of its text (issue #433). Drawn in the
   * same tint as a passage mark. The caller passes these OR a `highlight`: a
   * region's passage is the model's description of the drawing, and searching
   * the page's text for it would only search the neighbours next.
   */
  regions?: readonly PageRegion[] | null
  /**
   * Turn a passage the READER selected into the text they want on their
   * clipboard — a quotation with the document and page attached, the form a
   * Stellungnahme quotes in.
   *
   * A formatter rather than a component: the citation vocabulary belongs to
   * whoever opened this viewer (the chat knows the document's title, its
   * Richtlinie, its edition), and the viewer knows only which page the words
   * were on. Left unset the affordance is not offered at all, which is the
   * right answer for a plain file preview — the browser's own copy is enough
   * for someone who is not citing anything.
   */
  quoteFormat?: (quote: { text: string; page: number }) => string
  /**
   * Look for passages like the one the READER selected („Im Büro behandelt"):
   * the selection's words and the page they are on. Left unset, the offer is
   * not made. Like `quoteFormat` a callback, not a component: who may be
   * searched and where the answer is shown belong to whoever opened the viewer.
   */
  onFindSimilar?: (passage: { text: string; page: number }) => void
  /**
   * The document could not be opened (pdf.js failed to load, the stream
   * refused, the bytes are not a PDF). Left unset, the viewer shows its own
   * failure on the stage: what happened, a retry, and the browser's own viewer
   * as the way out. A caller that owns a failure state of its own (the Files
   * preview pane, whose retry asks the preview route again) passes this, and
   * the viewer then renders nothing on failure and leaves the answer to it.
   * A password-protected document is not a failure: the viewer asks for the
   * password either way.
   */
  onLoadError?: () => void
  /**
   * Who draws the ground the pages lie on. `stage` (the default): the viewer
   * brings its own recessed stage. `host`: the caller already lays one (the
   * chat peek's `InsetStage`), and a second one inside it would be a stage on
   * a stage. Everything else — the sheets, the pill, the rail — is the same.
   */
  ground?: 'stage' | 'host'
  /**
   * The stage runs to the screen's edges on a phone: the full-screen reader
   * (Files, the chat's file pill, a citation) lays the document edge to edge,
   * with the pages kept clear of the Dynamic Island and the home indicator by
   * the frame's safe-area padding rather than by a card's margin.
   */
  bleed?: boolean
  /**
   * What the caller lays over one page: marks it keeps itself (a document's
   * Anmerkungen), positioned in PERCENT of the page as `RegionMarks` are, so
   * they need no scale and survive every zoom. A render function rather than a
   * list of pins, for the reason `quoteFormat` is a formatter: what a mark
   * means belongs to whoever opened the viewer, and the viewer knows pages.
   */
  pageOverlay?: (page: number) => ReactNode
  /**
   * Controls the caller adds to the start of the viewer's own pill (a review
   * surface's tools), so a stage has one pill rather than two competing at its
   * foot. Rendered as they come, followed by a divider.
   */
  toolbarLead?: ReactNode | ((page: number) => ReactNode)
  /**
   * A point to bring to the middle of the view: a page, and the share of its
   * height to centre. A new `key` asks again for the same point. `instant`
   * jumps rather than glides, for a view that follows somebody else's.
   */
  focus?: { page: number; y: number; key: string | number; instant?: boolean } | null
  /**
   * Where the view is, whenever it moves: the page at its middle and the share
   * of that page's height there. For a reader others may follow.
   */
  onViewport?: (viewport: { page: number; y: number }) => void
  className?: string
}

export function usePdfDocumentViewController(props: PdfDocumentViewProps) {
  const {
  src,
  title,
  page,
  highlight,
  highlightColor,
  regions,
  quoteFormat,
  onFindSimilar,
  onLoadError,
  ground = 'stage',
  bleed = false,
  pageOverlay,
  toolbarLead,
  focus,
  onViewport,
  className,
  } = props
  const t = useTranslations(knowledgeCopy)
  const coarse = useMediaQuery('(pointer: coarse)')
  const gutter = coarse ? TOUCH_GUTTER : GUTTER
  const [doc, setDoc] = useState<PDFDocumentProxy | null>(null)
  const [loadState, setLoadState] = useState<LoadState>('loading')
  // Bumped by "try again", which re-runs the load with everything else equal.
  const [attempt, setAttempt] = useState(0)
  const [password, setPassword] = useState<string | null>(null)
  const [frame, setFrame] = useState({ width: 0, height: 0 })
  const [zoom, setZoom] = useState(1)
  // The reader's own choice of fit, once they have made one. Until then a
  // sheet that is wider than tall (a plan) is fitted WHOLE, and a page that is
  // taller than wide (a Bescheid) by its width: a plan fitted by its width on a
  // phone on its side showed its top third, and a Bescheid fitted whole is
  // a column of unreadable lines.
  const [chosenFit, setFit] = useState<FitMode | null>(null)
  const [railOpen, setRailOpen] = useState(true)
  const [hit, setHit] = useState<PassageHit | null>(null)
  // Page 1's shape, used to reserve room for pages that have not rasterised.
  const [defaultAspect, setDefaultAspect] = useState<number | null>(null)
  // Page 1's width in PDF points: what tells an A1 plan from a Bescheid, and
  // so how deep the zoom may go (`maxZoomFor`).
  const [firstPageWidth, setFirstPageWidth] = useState<number | null>(null)
  // Bumped to replay the arrival animation — a CSS animation only runs on
  // mount, so re-pinging means remounting the marks.
  const [ping, setPing] = useState(0)
  // Which page the reader is on, for the counter. Not the same question as
  // which page is rendered: several are, always.
  const [currentPage, setCurrentPage] = useState(1)
  // What the live region says, a beat after the page settles. Announcing every
  // page a fast scroll passes through would be a screen reader reading numbers
  // at the listener for as long as they scroll.
  const [announced, setAnnounced] = useState('')
  // Pages that read their text and did not hold the passage. Once every page
  // that could have held it has said so, the viewer can say so too.
  const [missed, setMissed] = useState<number[]>([])
  // The reader's own selection, in the content's coordinates, plus what to do
  // with it. Null whenever nothing is selected inside the document.
  const [quote, setQuote] = useState<QuoteSelection | null>(null)
  const [copied, setCopied] = useState<'idle' | 'done' | 'failed'>('idle')
  // Find in document. `hits` is null while a search is running.
  const [searchOpen, setSearchOpen] = useState(false)
  // Bumped by Cmd+F while the bar is already open, which focuses it again.
  const [searchFocus, setSearchFocus] = useState(0)
  const [query, setQuery] = useState('')
  const [searchedQuery, setSearchedQuery] = useState('')
  const [hits, setHits] = useState<SearchHit[] | null>([])
  const [activeHit, setActiveHit] = useState(0)

  const scrollRef = useRef<HTMLDivElement | null>(null)
  // The page stack itself. Selection coordinates are measured against THIS, not
  // the frame: it scrolls with the document, so the quote bar stays on the words
  // it belongs to instead of hanging in the frame while the text moves away.
  const contentRef = useRef<HTMLDivElement | null>(null)
  // The text the current offer is for, so a re-measure can tell a new selection
  // from the same one seen again.
  const quotedRef = useRef<string | null>(null)
  // Whether THIS question has already been answered, read synchronously so two
  // pages reporting a hit in the same tick cannot both act on it.
  const foundRef = useRef(false)
  const pageRefs = useRef(new Map<number, HTMLDivElement>())
  // Each page's unscaled width, so a rectangle in page coordinates can be
  // turned into a scroll offset at whatever size the page is drawn at NOW.
  const pageWidths = useRef(new Map<number, number>())
  // Each page's searchable text, built once per document and kept for the
  // next query: a reader refines a search keystroke by keystroke.
  const pageIndexes = useRef(new Map<number, PassageIndex>())
  // The zoom a gesture is building on. A pinch fires faster than React
  // re-renders, and building each step on the last RENDERED zoom would lose
  // the steps in between.
  const zoomRef = useRef(1)
  const anchorRef = useRef<ZoomAnchor | null>(null)
  // The one writer of the stack's transform while a zoom is live or settling.
  const [stackTransform] = useState(() => new ContentTransform())
  // The pages on screen redraw their sharp detail when this fires.
  const [viewSignal] = useState(createViewSignal)
  const currentPageRef = useRef(1)
  currentPageRef.current = currentPage

  useEffect(() => {
    let cancelled = false
    setDoc(null)
    setLoadState('loading')
    const parameters = password ? { ...documentParameters(src), password } : documentParameters(src)
    const task = loadPdfjs().then((pdfjs) => pdfjs.getDocument(parameters))
    task
      .then((loading) => loading.promise)
      .then((loaded) => {
        if (cancelled) return
        setDoc(loaded)
        setLoadState('ready')
      })
      .catch((error: unknown) => {
        if (!cancelled) setLoadState(passwordState(error) ?? 'failed')
      })
    return () => {
      cancelled = true
      // Tearing down the LOADING TASK is what releases the document and the
      // worker's copy of it — a document left open holds its page cache, which
      // for a scanned plan set is tens of megabytes. It also covers the race
      // where the dialog closes while the load is still in flight.
      void task.then((loading) => loading.destroy()).catch(() => {})
    }
  }, [src, password, attempt])

  // A new document is a new set of pages to search.
  useEffect(() => {
    pageIndexes.current = new Map()
  }, [doc])

  useEffect(() => {
    if (loadState === 'failed') onLoadError?.()
  }, [loadState, onLoadError])

  /**
   * Reserve realistic room for every page before any of them has rendered.
   *
   * Pages rasterise lazily, so without this the whole document starts as a
   * stack of near-empty boxes: the scrollbar is a lie, `offsetTop` for a page
   * deep in the document is far short of its final value, and the content
   * jumps as pages fill in. One `getPage(1)` gives the stack its true height,
   * because a PDF's pages are all but always the same size — and any page that
   * is not corrects itself the moment it renders.
   */
  useEffect(() => {
    if (!doc) return
    let cancelled = false
    doc
      .getPage(1)
      .then((first) => {
        if (cancelled) return
        const base = first.getViewport({ scale: 1 })
        setDefaultAspect(base.height / base.width)
        setFirstPageWidth(base.width)
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [doc])

  // A new Fundstelle is a new question. Clearing the old marks stops the
  // previous passage from staying lit on a page the reader has left, and lets
  // the "open at page" fallback run again for the new target.
  useEffect(() => {
    foundRef.current = false
    setHit(null)
    setMissed([])
  }, [page, highlight])

  useEffect(() => {
    const node = scrollRef.current
    if (!node || typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver((entries) => {
      const rect = entries[0]?.contentRect
      if (rect?.width) setFrame({ width: rect.width, height: rect.height || 0 })
    })
    observer.observe(node)
    return () => observer.disconnect()
  }, [doc])

  const fit: FitMode = chosenFit ?? (defaultAspect !== null && defaultAspect < 1 ? 'page' : 'width')
  const baseWidth = fitWidth({
    mode: fit,
    frameWidth: frame.width,
    frameHeight: frame.height,
    aspect: defaultAspect ?? PLACEHOLDER_PAGE_ASPECT,
    gutter,
    verticalPadding: FIT_PAGE_PADDING,
  })
  const targetWidth = frame.width > gutter ? baseWidth * zoom : 0
  // How deep this document may go: twice its print size, never under 8x.
  const maxZoom = maxZoomFor({ pageWidth: firstPageWidth, fitWidth: baseWidth })
  const maxZoomRef = useRef(maxZoom)
  maxZoomRef.current = maxZoom

  const setContentNode = useCallback(
    (node: HTMLDivElement | null) => {
      contentRef.current = node
      stackTransform.attach(node)
    },
    [stackTransform],
  )

  /**
   * Put the anchored point back under the fingers in the new layout, and play
   * whatever the layout cannot show exactly (a pinch held past the ceiling, a
   * scroll at the frame's edge, a double tap's whole zoom) as a settle from
   * what was on screen to what is laid out.
   */
  const applyAnchor = useCallback(() => {
    const anchor = anchorRef.current
    const frameNode = scrollRef.current
    const content = contentRef.current
    if (!anchor || !frameNode || !content) {
      stackTransform.release()
      return
    }
    anchorRef.current = null
    stackTransform.clear()
    const box = frameNode.getBoundingClientRect()
    const before = content.getBoundingClientRect()
    const pageNode = anchor.page === null ? undefined : pageRefs.current.get(anchor.page)
    const point = pageNode
      ? {
          x: pageNode.offsetLeft + anchor.fx * pageNode.offsetWidth,
          y: pageNode.offsetTop + anchor.fy * pageNode.offsetHeight,
        }
      : { x: anchor.contentX * anchor.ratio, y: anchor.contentY * anchor.ratio }
    frameNode.scrollTop = before.top - box.top + frameNode.scrollTop + point.y - anchor.y
    frameNode.scrollLeft = before.left - box.left + frameNode.scrollLeft + point.x - anchor.x
    const after = content.getBoundingClientRect()
    stackTransform.settle(
      anchoredTransform({
        scale: anchor.shown / zoomRef.current,
        point,
        origin: { x: after.left, y: after.top },
        at: { x: box.left + anchor.x, y: box.top + anchor.y },
      }),
      { animate: !prefersReducedMotion() },
    )
  }, [stackTransform])

  /**
   * Lay out the zoom a gesture, a button or a key asked for, keeping the
   * anchored point where it is on screen.
   *
   * The gesture has already SHOWN its zoom as a transform (see
   * `ContentTransform`); this makes it layout, once, and the layout effect
   * below puts the scroll where the transform had the page. Zooming about the
   * top-left corner instead throws the reader off the line they were reading
   * on every step.
   */
  const commitZoom = useCallback(
    (commit: ZoomCommit) => {
      const frameNode = scrollRef.current
      const target = clampZoom(commit.target, maxZoomRef.current)
      const drawn = zoomRef.current
      if (frameNode) {
        const box = frameNode.getBoundingClientRect()
        const pending = anchorRef.current
        // A second ask before the first was laid out (a key held down) builds
        // on where the first was going, not on a stale measurement.
        anchorRef.current = pending
          ? { ...pending, x: commit.clientX - box.left, y: commit.clientY - box.top, ratio: pending.ratio * (target / drawn) }
          : {
              x: commit.clientX - box.left,
              y: commit.clientY - box.top,
              ...pageShare(pageRefs.current, commit.contentX, commit.contentY),
              contentX: commit.contentX,
              contentY: commit.contentY,
              ratio: target / drawn,
              shown: commit.shown,
            }
      }
      if (Math.abs(target - drawn) < 1e-4) {
        // Nothing to lay out (a two-finger pan, a pinch that came back to
        // where it started): the transform still has to come off.
        applyAnchor()
        return
      }
      zoomRef.current = target
      setZoom(target)
    },
    [applyAnchor],
  )

  useLayoutEffect(() => {
    applyAnchor()
  }, [targetWidth, applyAnchor])

  /** Zoom from a button or a key: about the middle of the frame, or the given point, played as a settle. */
  const zoomTo = useCallback(
    (next: number, clientX?: number, clientY?: number) => {
      const frameNode = scrollRef.current
      const content = contentRef.current
      if (!frameNode || !content) {
        zoomRef.current = clampZoom(next, maxZoomRef.current)
        setZoom(zoomRef.current)
        return
      }
      stackTransform.finish()
      const box = frameNode.getBoundingClientRect()
      const stack = content.getBoundingClientRect()
      const x = clientX ?? box.left + frameNode.clientWidth / 2
      const y = clientY ?? box.top + frameNode.clientHeight / 2
      commitZoom({
        target: next,
        shown: zoomRef.current,
        clientX: x,
        clientY: y,
        contentX: x - stack.left,
        contentY: y - stack.top,
      })
    },
    [commitZoom, stackTransform],
  )

  const fitAgain = useCallback(() => zoomTo(1), [zoomTo])

  useZoomGestures(scrollRef, {
    enabled: Boolean(doc),
    contentRef,
    transform: stackTransform,
    zoom,
    maxZoom,
    onCommit: commitZoom,
  })

  /**
   * Tell the pages on screen the view has come to rest: after a scroll has
   * stopped, and after a zoom has settled. That is when each one decides
   * whether it needs a sharp detail of the part the reader is looking at.
   */
  useEffect(() => {
    const frameNode = scrollRef.current
    if (!frameNode || !doc) return
    let timer: number | null = null
    const schedule = (): void => {
      if (timer !== null) window.clearTimeout(timer)
      timer = window.setTimeout(() => {
        timer = null
        if (!stackTransform.active) viewSignal.emit()
      }, DETAIL_SETTLE_MS)
    }
    frameNode.addEventListener('scroll', schedule, { passive: true })
    const stopRest = stackTransform.onRest(schedule)
    return () => {
      if (timer !== null) window.clearTimeout(timer)
      frameNode.removeEventListener('scroll', schedule)
      stopRest()
    }
  }, [doc, stackTransform, viewSignal])

  // A new zoom or frame size is a new view too, once its layout has landed.
  useEffect(() => {
    if (!doc || targetWidth <= 0) return
    const timer = window.setTimeout(() => {
      if (!stackTransform.active) viewSignal.emit()
    }, DETAIL_SETTLE_MS + RERASTER_DELAY_MS)
    return () => window.clearTimeout(timer)
  }, [doc, targetWidth, stackTransform, viewSignal])

  const registerPage = useCallback((number: number, node: HTMLDivElement | null) => {
    if (node) pageRefs.current.set(number, node)
    else pageRefs.current.delete(number)
  }, [])

  const registerWidth = useCallback((number: number, width: number) => {
    pageWidths.current.set(number, width)
  }, [])

  // Marked only on the page they were stated for; with no page there is no
  // frame to draw a share of.
  const regionsOnPage = page && regions?.length ? regions : null

  /**
   * Put the cited region near the top of the frame — the same resting place a
   * located passage gets, measured the same way (see `scrollToRects`). A
   * region is a share of the page, so the page's rendered height is all the
   * geometry it needs.
   */
  const scrollToRegion = useCallback(
    (smooth: boolean) => {
      const frameNode = scrollRef.current
      const pageNode = page ? pageRefs.current.get(page) : undefined
      if (!frameNode || !pageNode || !regionsOnPage) return
      const top = Math.min(...regionsOnPage.map((region) => region.box[1]))
      const pageTop =
        pageNode.getBoundingClientRect().top - frameNode.getBoundingClientRect().top + frameNode.scrollTop
      const offset = pageTop + top * pageNode.clientHeight - frameNode.clientHeight * PASSAGE_SCROLL_OFFSET
      frameNode.scrollTo({ top: Math.max(0, offset), behavior: scrollBehavior(smooth) })
    },
    [page, regionsOnPage],
  )

  /**
   * Put a set of marks — a located passage, a search hit — near the top of the
   * frame.
   *
   * Scrolling to the PAGE and scrolling to the PASSAGE are different answers,
   * and only the second is what the click asked for — landing at the top of
   * page 12 when the sentence sits at its foot leaves the reader searching
   * exactly as the old iframe did.
   */
  const scrollToRects = useCallback((target: { page: number; rects: HighlightRect[] }, smooth: boolean) => {
    const frameNode = scrollRef.current
    const pageNode = pageRefs.current.get(target.page)
    const bounds = passageBounds(target.rects)
    if (!frameNode || !pageNode || !bounds) return
    // Measured against the FRAME, not read off `offsetTop`. `offsetTop` counts
    // from the nearest POSITIONED ancestor, and this scroller sets no position
    // — so the number included the dialog's header, and on a phone the whole
    // Fundstellen rail stacked above the document as well. The viewer then
    // scrolled that much too far and left the passage it had just found off the
    // top of the frame. Rects plus the current `scrollTop` are the same
    // measurement no matter what is above the frame. (A phone-viewport capture
    // of the citation viewer is the evidence; jsdom lays nothing out, so no
    // unit test can hold this.)
    const box = frameNode.getBoundingClientRect()
    const pageBox = pageNode.getBoundingClientRect()
    const unscaled = pageWidths.current.get(target.page)
    const scale = unscaled && pageBox.width ? pageBox.width / unscaled : 1
    const pageTop = pageBox.top - box.top + frameNode.scrollTop
    const top = pageTop + bounds.y * scale - frameNode.clientHeight * PASSAGE_SCROLL_OFFSET
    // Sideways too, once zoomed past the frame: a hit at the right edge of a
    // plan sheet is otherwise scrolled to and still off screen.
    const pageLeft = pageBox.left - box.left + frameNode.scrollLeft
    const left = pageLeft + (bounds.x + bounds.width / 2) * scale - frameNode.clientWidth / 2
    frameNode.scrollTo({
      top: Math.max(0, top),
      left: Math.max(0, left),
      behavior: scrollBehavior(smooth),
    })
  }, [])

  /** Scroll to the passage AND announce it — what a fresh citation deserves. */
  const revealPassage = useCallback(
    (target: PassageHit) => {
      setPing((previous) => previous + 1)
      scrollToRects(target, true)
    },
    [scrollToRects],
  )

  /**
   * Take the FIRST passage offered for this question, and only the first.
   *
   * Two pages can answer: the cited one and, once it has come up empty, its
   * neighbours. And one page can answer twice — a page that scrolls out of the
   * render band and back re-reads its text layer. Without this guard the second
   * answer scrolls and re-pulses, which means a reader who deliberately paged
   * away is dragged back to the citation for having scrolled too far.
   */
  const handlePassage = useCallback(
    (found: PassageHit) => {
      if (foundRef.current) return
      foundRef.current = true
      setHit(found)
      revealPassage(found)
    },
    [revealPassage],
  )

  /**
   * A page that read its text and did not hold the passage says so. The search
   * radius is derived from these misses, see {@link searchRadius}.
   */
  const handleMiss = useCallback((missedPage: number) => {
    setMissed((current) =>
      current.includes(missedPage) ? current : [...current, missedPage],
    )
  }, [])

  // How far either side of the cited page the passage is still looked for.
  const radius = searchRadius(page, missed, doc?.numPages ?? 0)

  /**
   * Re-apply the scroll once the page stack has settled.
   *
   * A page that has never rasterised only knows its height once
   * `defaultAspect` arrives or it enters the render band. Until then the pages
   * above the target are shorter than they will be, so the first scroll to a
   * passage deep in a long document lands well short of it. Correcting on the
   * next frame, without a pulse and without smooth scrolling (the first scroll
   * is still animating), settles it.
   */
  useEffect(() => {
    if (!hit || !defaultAspect) return
    const raf = requestAnimationFrame(() => scrollToRects(hit, false))
    return () => cancelAnimationFrame(raf)
  }, [hit, defaultAspect, scrollToRects])

  // Opening at a page is the answer when there is no passage to find, and the
  // starting point while the target page's text layer is still being read. A
  // located passage supersedes it. Re-apply once `defaultAspect` lands: the
  // first scroll runs while unrendered pages still have no height, so it
  // leaves the reader at the top of a document that then grows underneath
  // them (#430). A cited region is the same answer one step finer.
  useEffect(() => {
    if (!doc || !page || hit) return
    if (regionsOnPage) scrollToRegion(false)
    else pageRefs.current.get(page)?.scrollIntoView({ block: 'start' })
  }, [doc, page, hit, defaultAspect, regionsOnPage, scrollToRegion])

  /**
   * Which page the reader is on.
   *
   * One observer over the whole stack rather than a handler per scroll event:
   * a 200-page document would otherwise measure 200 rectangles per frame to
   * answer a question the browser is already computing.
   */
  useEffect(() => {
    const frameNode = scrollRef.current
    if (!doc || !frameNode || typeof IntersectionObserver === 'undefined') return
    // Which pages are in the band, kept ACROSS callbacks. A batch reports
    // changes — the page leaving and the page arriving — not the whole truth.
    const inBand = new Map<number, boolean>()
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          const number = Number((entry.target as HTMLElement).dataset.page)
          if (Number.isFinite(number)) inBand.set(number, entry.isIntersecting)
        }
        const [first] = [...inBand]
          .filter(([, isInBand]) => isInBand)
          .map(([number]) => number)
          .sort((a, b) => a - b)
        // Lowest wins, so the moment a page boundary straddles the band the
        // counter reads as the page you are still leaving rather than flicking
        // forward and back across it.
        if (first) setCurrentPage(first)
      },
      { root: frameNode, rootMargin: CURRENT_PAGE_BAND },
    )
    pageRefs.current.forEach((node) => observer.observe(node))
    return () => observer.disconnect()
  }, [doc])

  // Say where the reader is, once they have stopped moving.
  const position = doc ? t('viewer.pagePosition', { page: currentPage, count: doc.numPages }) : ''
  useEffect(() => {
    if (!position) return
    const timer = window.setTimeout(() => setAnnounced(position), ANNOUNCE_DELAY_MS)
    return () => window.clearTimeout(timer)
  }, [position])

  /** Go to a page: its top edge to the top of the frame. */
  const goToPage = useCallback(
    (requested: number) => {
      const frameNode = scrollRef.current
      if (!doc || !frameNode) return
      const target = clampPage(requested, doc.numPages)
      const pageNode = pageRefs.current.get(target)
      if (!pageNode) return
      const top =
        pageNode.getBoundingClientRect().top - frameNode.getBoundingClientRect().top + frameNode.scrollTop
      // A smooth scroll passes through every page in between, and the counter
      // would read each of them out; the page asked for is the answer now.
      setCurrentPage(target)
      frameNode.scrollTo({ top: Math.max(0, top - 12), behavior: scrollBehavior(true) })
    },
    [doc],
  )

  // Bring the caller's point to the middle of the view. Keyed, so the same
  // point can be asked for twice (the reader scrolled away and asks again).
  const focusKey = focus ? `${focus.key}` : null
  const focusRef = useRef(focus)
  focusRef.current = focus
  useEffect(() => {
    const frameNode = scrollRef.current
    const focus = focusRef.current
    if (!focus || !doc || !frameNode) return
    const pageNode = pageRefs.current.get(clampPage(focus.page, doc.numPages))
    if (!pageNode) return
    const frameBox = frameNode.getBoundingClientRect()
    const pageBox = pageNode.getBoundingClientRect()
    const pointTop = pageBox.top - frameBox.top + frameNode.scrollTop + focus.y * pageBox.height
    frameNode.scrollTo({
      top: Math.max(0, pointTop - frameBox.height / 2),
      behavior: scrollBehavior(!focus.instant),
    })
  }, [focusKey, doc])

  // Say where the view is, once a frame at most, for whoever follows it.
  const onViewportRef = useRef(onViewport)
  onViewportRef.current = onViewport
  const reportsViewport = onViewport !== undefined
  useEffect(() => {
    const frameNode = scrollRef.current
    if (!frameNode || !doc || !reportsViewport) return
    let frame: number | null = null
    const report = () => {
      frame = null
      const frameBox = frameNode.getBoundingClientRect()
      const middle = frameBox.top + frameBox.height / 2
      for (const [number, node] of pageRefs.current) {
        const box = node.getBoundingClientRect()
        if (box.top <= middle && box.bottom >= middle && box.height > 0) {
          onViewportRef.current?.({ page: number, y: Math.min(1, Math.max(0, (middle - box.top) / box.height)) })
          return
        }
      }
    }
    const onScroll = () => {
      if (frame === null) frame = requestAnimationFrame(report)
    }
    frameNode.addEventListener('scroll', onScroll, { passive: true })
    return () => {
      frameNode.removeEventListener('scroll', onScroll)
      if (frame !== null) cancelAnimationFrame(frame)
    }
  }, [doc, reportsViewport])

  /**
   * Read the reader's selection: what it says, which page it is on, and where
   * to hang the offer to quote it. Nothing selected inside the document
   * withdraws the offer.
   */
  const readSelection = useCallback((): void => {
    const frameNode = scrollRef.current
    const content = contentRef.current
    if (!(quoteFormat || onFindSimilar) || !frameNode || !content) return

    const selection = document.getSelection()
    const range =
      selection && !selection.isCollapsed && selection.rangeCount > 0
        ? selection.getRangeAt(0)
        : null
    const node = range
      ? range.commonAncestorContainer.nodeType === Node.ELEMENT_NODE
        ? (range.commonAncestorContainer as Element)
        : range.commonAncestorContainer.parentElement
      : null
    const text = range ? selection!.toString().trim() : ''
    // A selection outside this document is somebody else's, and a two-character
    // one is a mis-click rather than a quotation.
    if (!range || !node || !frameNode.contains(node) || text.length < MIN_QUOTE_LENGTH) {
      quotedRef.current = null
      return setQuote(null)
    }

    // Only a NEW selection clears the confirmation. Re-measuring after a zoom
    // must not wipe the "copied" the reader just earned.
    if (quotedRef.current !== text) {
      quotedRef.current = text
      setCopied('idle')
    }
    const rect = range.getBoundingClientRect()
    const origin = content.getBoundingClientRect()
    setQuote({
      text,
      page: Number(node.closest('[data-page]')?.getAttribute('data-page')) || currentPageRef.current,
      x: rect.left - origin.left,
      y: rect.top - origin.top,
    })
  }, [quoteFormat, onFindSimilar])

  /**
   * Ask on RELEASE, not on every `selectionchange`: mid-drag the offer would
   * chase the cursor across the page. `selectionchange` is still listened to,
   * for the opposite job — the moment the selection collapses, the offer goes.
   */
  useEffect(() => {
    const frameNode = scrollRef.current
    if (!(quoteFormat || onFindSimilar) || !frameNode) return

    const collapse = (): void => {
      const selection = document.getSelection()
      if (!selection || selection.isCollapsed) setQuote(null)
    }

    frameNode.addEventListener('pointerup', readSelection)
    frameNode.addEventListener('keyup', readSelection)
    document.addEventListener('selectionchange', collapse)
    return () => {
      frameNode.removeEventListener('pointerup', readSelection)
      frameNode.removeEventListener('keyup', readSelection)
      document.removeEventListener('selectionchange', collapse)
    }
  }, [quoteFormat, onFindSimilar, readSelection, doc])

  // The offer is placed in the page stack's coordinates, and a zoom step moves
  // every word under it. Re-measuring keeps it on the sentence.
  useEffect(() => {
    // The ref rather than the state, deliberately: this effect WRITES the
    // selection state, so reading it here would make the effect its own trigger.
    if (quotedRef.current) readSelection()
  }, [targetWidth, readSelection])

  const copyQuote = useCallback(async (): Promise<void> => {
    if (!quote || !quoteFormat) return
    try {
      await navigator.clipboard.writeText(quoteFormat({ text: quote.text, page: quote.page }))
      setCopied('done')
    } catch {
      // Blocked clipboard, insecure context, denied permission. Saying so in
      // the bar beats a silent button: the reader is about to paste.
      setCopied('failed')
    }
  }, [quote, quoteFormat])

  // Let the confirmation fade by itself.
  useEffect(() => {
    if (copied === 'idle') return
    const timer = window.setTimeout(() => setCopied('idle'), COPIED_FEEDBACK_MS)
    return () => window.clearTimeout(timer)
  }, [copied])

  // ---- Find in document --------------------------------------------------

  useEffect(() => {
    const timer = window.setTimeout(() => setSearchedQuery(query), SEARCH_DEBOUNCE_MS)
    return () => window.clearTimeout(timer)
  }, [query])

  const queryTooShort = normalizePassage(searchedQuery).length < MIN_SEARCH_QUERY

  /**
   * Search every page's text layer for the query. The pages' text is read
   * once per document, through the same reader the passage search uses, and
   * kept: refining „Brand" to „Brandabschnitt" re-reads nothing. Page by page
   * and awaited, so a two-hundred-page document is searched without one long
   * task, and a newer query abandons an older one mid-document.
   */
  useEffect(() => {
    if (!doc || !searchOpen || queryTooShort) {
      setHits([])
      return
    }
    let cancelled = false
    setHits(null)
    const run = async (): Promise<void> => {
      const found: SearchHit[] = []
      for (let number = 1; number <= doc.numPages; number += 1) {
        let index = pageIndexes.current.get(number)
        if (!index) {
          const pdfPage = await doc.getPage(number)
          if (cancelled) return
          const items = await readPageTextItems(pdfPage)
          if (cancelled) return
          const unscaled = pdfPage.getViewport({ scale: 1 })
          pageWidths.current.set(number, unscaled.width)
          index = buildPassageIndex(pageTextChunks(items, unscaled.transform), canvasMeasure())
          pageIndexes.current.set(number, index)
        }
        for (const rects of findOccurrences(index, searchedQuery)) found.push({ page: number, rects })
      }
      if (cancelled) return
      setHits(found)
      // Start where the reader is, not at the top of the document.
      const ahead = found.findIndex((entry) => entry.page >= currentPageRef.current)
      setActiveHit(ahead === -1 ? 0 : ahead)
    }
    void run().catch(() => {
      if (!cancelled) setHits([])
    })
    return () => {
      cancelled = true
    }
  }, [doc, searchOpen, searchedQuery, queryTooShort])

  const shownHit = hits?.[activeHit] ?? null
  useEffect(() => {
    if (shownHit) scrollToRects(shownHit, true)
  }, [shownHit, scrollToRects])

  const stepHit = useCallback(
    (direction: 1 | -1) => {
      if (!hits?.length) return
      setActiveHit((current) => (current + direction + hits.length) % hits.length)
    },
    [hits],
  )

  const searchMarks = useMemo(() => {
    const byPage = new Map<number, Array<{ rects: HighlightRect[]; active: boolean }>>()
    hits?.forEach((entry, index) => {
      const list = byPage.get(entry.page) ?? []
      list.push({ rects: entry.rects, active: index === activeHit })
      byPage.set(entry.page, list)
    })
    return byPage
  }, [hits, activeHit])

  const openSearch = useCallback(() => {
    setSearchOpen(true)
    setSearchFocus((value) => value + 1)
  }, [])

  const closeSearch = useCallback(() => {
    setSearchOpen(false)
    setQuery('')
    setSearchedQuery('')
    // Back to the document, so the keys that move through it work again.
    scrollRef.current?.focus({ preventScroll: true })
  }, [])

  /**
   * The viewer's keys, while focus is inside it. Bound on the viewer's root,
   * so Cmd+F and Cmd+0 are taken from the browser only while the reader is in
   * the document, and two viewers on one screen never answer for each other.
   */
  const onKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLDivElement>) => {
      if (!doc || event.defaultPrevented) return
      const target = event.target as HTMLElement
      const frameNode = scrollRef.current
      const action = viewerKeyAction(event, {
        inField: target.closest('input, textarea, [contenteditable="true"]') !== null,
        overflowsSideways: frameNode ? frameNode.scrollWidth > frameNode.clientWidth + 1 : false,
      })
      if (!action) return
      event.preventDefault()
      if (action.kind === 'search') return openSearch()
      if (action.kind === 'fit') return fitAgain()
      if (action.kind === 'zoom') return zoomTo(stepZoom(zoomRef.current, action.direction, maxZoomRef.current))
      const to = {
        next: currentPageRef.current + 1,
        previous: currentPageRef.current - 1,
        first: 1,
        last: doc.numPages,
      }[action.to]
      goToPage(to)
    },
    [doc, openSearch, fitAgain, zoomTo, goToPage],
  )

  const pages = useMemo(
    () => (doc ? Array.from({ length: doc.numPages }, (_, index) => index + 1) : []),
    [doc],
  )

  // A document is on screen once pdf.js has parsed it, not when the viewer
  // mounts. The kind and the renderer, never the name or the page count.
  useEffect(() => {
    if (doc) capturePosthog('document_opened', { kind: 'pdf', library: 'pdfjs' })
  }, [doc])

  // Every page that could hold this passage has read its text and none did.
  // Until all of them have answered the viewer says nothing, because "not
  // found" and "still looking" are different claims and only one is true yet.
  const candidatePages =
    doc && page && highlight
      ? pagesWithin(page, MAX_SEARCH_RADIUS, doc.numPages)
      : []
  const passageMissing =
    !hit && candidatePages.length > 0 && candidatePages.every((number) => missed.includes(number))

  const revealCited =
    hit || regionsOnPage
      ? () => {
          if (hit) return revealPassage(hit)
          setPing((previous) => previous + 1)
          scrollToRegion(true)
        }
      : undefined

  const Ground = ground === 'stage' ? InsetStage : HostGround
  return {
    Ground,
    activeHit,
    anchorRef,
    announced,
    applyAnchor,
    attempt,
    baseWidth,
    bleed,
    candidatePages,
    chosenFit,
    className,
    closeSearch,
    coarse,
    commitZoom,
    contentRef,
    copied,
    copyQuote,
    currentPage,
    currentPageRef,
    defaultAspect,
    doc,
    firstPageWidth,
    fit,
    fitAgain,
    focus,
    focusKey,
    focusRef,
    foundRef,
    frame,
    goToPage,
    ground,
    gutter,
    handleMiss,
    handlePassage,
    highlight,
    highlightColor,
    hit,
    hits,
    loadState,
    maxZoom,
    maxZoomRef,
    missed,
    onFindSimilar,
    onKeyDown,
    onLoadError,
    onViewport,
    onViewportRef,
    openSearch,
    page,
    pageIndexes,
    pageOverlay,
    pageRefs,
    pageWidths,
    pages,
    passageMissing,
    password,
    ping,
    position,
    query,
    queryTooShort,
    quote,
    quoteFormat,
    quotedRef,
    radius,
    railOpen,
    readSelection,
    regions,
    regionsOnPage,
    registerPage,
    registerWidth,
    reportsViewport,
    revealCited,
    revealPassage,
    scrollRef,
    scrollToRects,
    scrollToRegion,
    searchFocus,
    searchMarks,
    searchOpen,
    searchedQuery,
    setActiveHit,
    setAnnounced,
    setAttempt,
    setContentNode,
    setCopied,
    setCurrentPage,
    setDefaultAspect,
    setDoc,
    setFirstPageWidth,
    setFit,
    setFrame,
    setHit,
    setHits,
    setLoadState,
    setMissed,
    setPassword,
    setPing,
    setQuery,
    setQuote,
    setRailOpen,
    setSearchFocus,
    setSearchOpen,
    setSearchedQuery,
    setZoom,
    shownHit,
    src,
    stackTransform,
    stepHit,
    t,
    targetWidth,
    title,
    toolbarLead,
    viewSignal,
    zoom,
    zoomRef,
    zoomTo,
  }
}

export type PdfDocumentViewController = ReturnType<typeof usePdfDocumentViewController>
