'use client'

import { useEffect, useRef, useState, type CSSProperties, type JSX, type PointerEvent as ReactPointerEvent } from 'react'
import { Crosshair, Sparkles, SquareDashed } from 'lucide-react'
import { AnimatePresence, motion, motionBase, springGlide, useMotionToken } from '@/components/motion'
import { COMMENT_PIN_ON_POINT, CommentPin } from '@/components/ui/comment-pin'
import { identityInk } from '@/components/ui/avatar-identity'
import { LiveCursor } from '@/components/ui/live-cursor'
import { PilotiGlyph } from '@/components/ui/piloti-glyph'
import { WorkingDots } from '@/components/ui/working-dots'
import { useTranslations } from '@/i18n'
import { isLive, type AnnotationView } from '@/lib/annotations/types'
import { cn } from '@/lib/utils'
import { askRegionOf, type CanvasAsk } from '../../hooks/use-canvas-ask'
import type { DocumentReview, ReviewDraft, ReviewTool } from '../../hooks/use-document-review'
import type { RoomPeerState } from '../../hooks/use-document-room'
import { usePilotiByline } from './piloti-attribution'

/** A region smaller than this share of the page, in both directions, was a click: it becomes a point. */
const MIN_REGION = 0.012

/** How far a press may travel, in CSS pixels, and still set a point where it began. */
const POINT_SLOP = 8

const at = (x: number, y: number): CSSProperties => ({ left: `${x * 100}%`, top: `${y * 100}%` })
const box = (x: number, y: number, w: number, h: number): CSSProperties => ({
  left: `${x * 100}%`,
  top: `${y * 100}%`,
  width: `${w * 100}%`,
  height: `${h * 100}%`,
})

/** How long a box Piloti pointed out stays on the page, unless it points out the next one first. */
const HIGHLIGHT_MS = 6_000

/** What the room is told the pointer is doing: asking Piloti is dragging out a region too. */
const roomTool = (tool: ReviewTool) => (tool === 'ask' ? 'region' : tool)

/** A box Piloti points out on a page, with what it says about it. */
export interface PilotiHighlight {
  page: number
  x: number
  y: number
  w: number
  h: number
  label: string | null
}

/**
 * What Piloti points out, read off its peer: its latest highlight while it
 * lasts, else the region its activity says it is reading.
 */
export function pilotiHighlightOf(state: RoomPeerState, now = Date.now()): PilotiHighlight | null {
  if (state.peer.kind !== 'piloti') return null
  if (state.highlight && state.highlight.expiresAt > now) {
    return { ...state.highlight.box, label: state.highlight.label }
  }
  const box = state.activity?.box
  return box ? { ...box, label: state.activity?.label ?? null } : null
}

/** Whether a peer is Piloti at work on the document. */
export const isPilotiPeer = (state: RoomPeerState): boolean => state.peer.kind === 'piloti'

/**
 * The first name of the person Piloti acts for, short enough for a tag beside
 * a pointer: „Anna" for „Anna Berger", the local part for a bare address.
 * Null when the server could not name them.
 */
export function pilotiForShort(peer: Pick<RoomPeerState['peer'], 'forName'>): string | null {
  const first = peer.forName?.trim().split(/\s+/)[0]?.split('@')[0]
  return first || null
}

/**
 * Piloti's own pointer, moved by its tools: ink, its spark, what it is doing
 * as the tag, with dots while it works, and always whose request it works on
 * („Piloti · für Anna", „Treppe · für Anna"; ADR-0105, EU AI Act Art. 50).
 * The words truncate; the „für Anna" after them never does.
 */
function PilotiCursor({ state }: { state: RoomPeerState }): JSX.Element {
  const tPresence = useTranslations('presence')
  const forShort = pilotiForShort(state.peer)
  const dots = state.activity ? <WorkingDots className="ml-0.5" /> : undefined
  return (
    <LiveCursor
      color="var(--foreground)"
      label={pilotiCursorLabel(state, tPresence('piloti.reading', { page: state.activity?.box?.page ?? 1 }))}
      icon={<Sparkles className="size-3" aria-hidden />}
      busy={
        forShort ? (
          <>
            <span data-testid="piloti-cursor-for" className="shrink-0">
              {tPresence('piloti.forSuffix', { name: forShort })}
            </span>
            {dots}
          </>
        ) : (
          dots
        )
      }
      className="[&_path]:fill-foreground"
    />
  )
}

/**
 * The words on Piloti's tag: always its name first, so a pointer that says
 * „Fluchtweg" is never mistaken for a colleague called that, then what it
 * points at, or what it reads.
 */
export function pilotiCursorLabel(state: Pick<RoomPeerState, 'label' | 'activity'>, reading: string): string {
  const doing = state.label || state.activity?.label || (state.activity?.state === 'reading' ? reading : null)
  return doing ? `Piloti · ${doing}` : 'Piloti'
}

/** A clock that ticks while there is something to age (pointers going idle); still otherwise. */
function useTick(active: boolean, everyMs: number): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!active) return
    const timer = setInterval(() => setNow(Date.now()), everyMs)
    return () => clearInterval(timer)
  }, [active, everyMs])
  return now
}

/** How long a pointer may rest before it reads as idle: its tag folds away, the arrow quiets. */
export const CURSOR_IDLE_MS = 8_000

/**
 * The marks the others have open, by mark: one face per person (a person in
 * two tabs is one), never this reader's own other tabs, never Piloti, which
 * says what it does with its pointer instead.
 */
export function peerSelections(
  peers: readonly RoomPeerState[],
  selfUserId: string | null
): Map<string, RoomPeerState[]> {
  const byMark = new Map<string, RoomPeerState[]>()
  for (const state of peers) {
    if (!state.selected || isPilotiPeer(state) || state.peer.userId === selfUserId) continue
    const here = byMark.get(state.selected) ?? []
    if (!here.some((other) => other.peer.userId === state.peer.userId)) byMark.set(state.selected, [...here, state])
  }
  return byMark
}

/** A first name for a tag beside a mark: „Anna" for „Anna Berger", the local part of a bare address. */
const firstName = (name: string): string => name.trim().split(/\s+/)[0]?.split('@')[0] || name

/**
 * Whose eyes are on a mark: the others who have it open, in their colour, the
 * way a design tool outlines what a colleague selected. A ring round the pin
 * (an outline round a region) and their first name beside it; „Anna +2" when
 * several are on it.
 */
function PeerSelection({
  annotation,
  selectors,
}: {
  annotation: Pick<AnnotationView, 'shape' | 'x' | 'y' | 'w' | 'h'>
  selectors: readonly RoomPeerState[]
}): JSX.Element | null {
  const t = useTranslations('files')
  const first = selectors[0]
  if (!first) return null
  const ink = identityInk(first.peer.userId)
  const names = selectors.map((state) => firstName(state.peer.name))
  const tag = names.length > 1 ? `${names[0]} +${names.length - 1}` : names[0]
  const region = annotation.shape === 'region' && annotation.w && annotation.h ? annotation : null
  return (
    <>
      {region ? (
        <span
          aria-hidden
          data-testid="review-peer-selection"
          className="pointer-events-none absolute z-20 rounded-[3px]"
          style={{ ...box(region.x, region.y, region.w ?? 0, region.h ?? 0), outline: `2px solid ${ink}`, outlineOffset: 2 }}
        />
      ) : (
        <span
          aria-hidden
          data-testid="review-peer-selection"
          className="pointer-events-none absolute z-[9] size-8 -translate-x-1 -translate-y-7 rounded-full rounded-bl-none border-2"
          style={{ ...at(annotation.x, annotation.y), borderColor: ink }}
        />
      )}
      <span
        className={cn(
          'pointer-events-none absolute z-20 rounded-full px-1.5 py-px text-[10px] leading-4 font-medium whitespace-nowrap text-white shadow-sm',
          region ? '-translate-y-[calc(100%+4px)]' : 'translate-x-8 -translate-y-6'
        )}
        style={{ ...at(annotation.x, annotation.y), backgroundColor: ink }}
        title={t('review.peerSelected', { names: selectors.map((state) => state.peer.name).join(', ') })}
        data-testid="review-peer-selection-tag"
      >
        {tag}
      </span>
    </>
  )
}

/**
 * The boxes Piloti pointed out, each shown until it points out the next or
 * {@link HIGHLIGHT_MS} passes: a highlight is a gesture, not a mark.
 */
function useHighlights(peers: readonly RoomPeerState[]): Array<PilotiHighlight & { key: string }> {
  const [shown, setShown] = useState<Array<PilotiHighlight & { key: string; peerId: string }>>([])
  const current = peers.flatMap((state) => {
    const highlight = pilotiHighlightOf(state)
    if (!highlight) return []
    const key = `${state.peer.peerId}:${highlight.page}:${highlight.x}:${highlight.y}:${highlight.w}:${highlight.h}:${highlight.label ?? ''}`
    return [{ ...highlight, key, peerId: state.peer.peerId }]
  })
  const signature = current.map((highlight) => highlight.key).join('|')
  const latest = useRef(current)
  latest.current = current
  const timers = useRef(new Map<string, ReturnType<typeof setTimeout>>())
  useEffect(() => {
    const arrived = latest.current
    if (arrived.length === 0) return
    setShown((before) => [
      ...before.filter((old) => !arrived.some((next) => next.peerId === old.peerId)),
      ...arrived.filter((next) => !before.some((old) => old.key === next.key)),
      ...before.filter((old) => arrived.some((next) => next.key === old.key)),
    ])
    for (const highlight of arrived) {
      if (timers.current.has(highlight.key)) continue
      timers.current.set(
        highlight.key,
        setTimeout(() => {
          timers.current.delete(highlight.key)
          setShown((before) => before.filter((old) => old.key !== highlight.key))
        }, HIGHLIGHT_MS)
      )
    }
  }, [signature])
  useEffect(() => {
    const pending = timers.current
    return () => {
      for (const timer of pending.values()) clearTimeout(timer)
      pending.clear()
    }
  }, [])
  return shown
}

/** Whose colour a mark wears: Piloti's ink, or the person who set it. */
export function markInk(annotation: Pick<AnnotationView, 'authorKind' | 'createdBy'>): string {
  return annotation.authorKind === 'piloti' ? 'var(--foreground)' : identityInk(annotation.createdBy)
}

/** The point on a page an event hit, as shares of the page, clamped onto it. */
function pointIn(element: HTMLElement, event: { clientX: number; clientY: number }) {
  const rect = element.getBoundingClientRect()
  if (rect.width <= 0 || rect.height <= 0) return null
  // Four decimals: a tenth of a millimetre on an A1 sheet, and no 0.30000000000000004 in a stored mark.
  const clamp = (value: number) => Math.round(Math.min(1, Math.max(0, value)) * 10_000) / 10_000
  return { x: clamp((event.clientX - rect.left) / rect.width), y: clamp((event.clientY - rect.top) / rect.height) }
}

/**
 * Somebody's pointer, gliding between the samples the room delivers. The
 * samples are about 80ms apart; the glide is a spring on transform only, so a
 * dozen updates a second read as one continuous hand.
 */
function GlidingCursor({
  x,
  y,
  size,
  children,
}: {
  x: number
  y: number
  size: { width: number; height: number }
  children: JSX.Element
}): JSX.Element {
  const glide = useMotionToken(springGlide)
  return (
    <motion.span
      className="pointer-events-none absolute top-0 left-0 z-30"
      initial={false}
      animate={{ x: x * size.width, y: y * size.height }}
      transition={glide}
    >
      {children}
    </motion.span>
  )
}

/**
 * Everything the review lays over ONE page, through the viewer's
 * `pageOverlay`: the marks, the draft being set, the surface that takes a
 * click or a drag while a tool is in hand, other people's pointers, and
 * Piloti's: its own pointer and the boxes it points out, both moved by its
 * tools through the room, and the boxes this reader asked it about.
 *
 * It also reports this reader's pointer to the room, from the page sheet it
 * sits in, so a colleague sees where on the drawing they are pointing.
 *
 * `focused`: the full review. Off, the inline preview: marks and company only,
 * no tools, and a click on a mark opens the review at it.
 */
export function ReviewPageLayer({
  page,
  review,
  focused,
  onOpenMark,
  renderThread,
  renderAsk,
}: {
  page: number
  review: DocumentReview
  focused: boolean
  /** The inline preview's way into the review: a mark was clicked. */
  onOpenMark?: (annotationId: string) => void
  /** The thread card for the selected mark or the draft, anchored here when it is on this page. */
  renderThread?: (anchor: { x: number; y: number; flip: boolean }) => JSX.Element | null
  /** Piloti's card for the question open on a box of this page. */
  renderAsk?: (ask: CanvasAsk, anchor: { x: number; y: number; flip: boolean }) => JSX.Element | null
}): JSX.Element {
  const t = useTranslations('files')
  const byline = usePilotiByline()
  const layerRef = useRef<HTMLDivElement | null>(null)
  const [size, setSize] = useState({ width: 0, height: 0 })
  const [drag, setDrag] = useState<{ x0: number; y0: number; x1: number; y1: number } | null>(null)
  // The fingers on the capture surface, and where the press began: a second
  // finger turns a mark into a pinch, and a point is set on RELEASE, so a
  // press that turns out to be a pan sets nothing.
  const pressRef = useRef<{ pointers: Set<number>; start: { x: number; y: number; clientX: number; clientY: number } | null; cancelled: boolean }>({
    pointers: new Set(),
    start: null,
    cancelled: false,
  })
  const { annotations, tool, draft, selectedId, hoveredId, room, filter, piloti } = review
  const { sendCursor, sendDraft } = room
  const highlights = useHighlights(room.peers).filter((highlight) => highlight.page === page)

  // The page's size, for the pointers' glide (in pixels, on transform).
  useEffect(() => {
    const node = layerRef.current
    if (!node || typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(([entry]) =>
      setSize({ width: entry.contentRect.width, height: entry.contentRect.height })
    )
    observer.observe(node)
    return () => observer.disconnect()
  }, [])

  // This reader's pointer, read off the whole sheet (text layer and all), told to the room.
  useEffect(() => {
    const sheet = layerRef.current?.parentElement?.parentElement
    if (!sheet) return
    const move = (event: PointerEvent) => {
      const point = pointIn(sheet, event)
      if (point) sendCursor({ page, ...point }, roomTool(tool))
    }
    const leave = () => sendCursor(null, roomTool(tool))
    sheet.addEventListener('pointermove', move)
    sheet.addEventListener('pointerleave', leave)
    return () => {
      sheet.removeEventListener('pointermove', move)
      sheet.removeEventListener('pointerleave', leave)
    }
  }, [page, sendCursor, tool])

  const visible = (annotation: AnnotationView) =>
    annotation.page === page &&
    annotation.onCurrentFassung &&
    (isLive(annotation) || (focused && filter === 'closed') || annotation.id === selectedId)
  const marks = annotations.filter(visible)
  const pointers = room.peers.filter((state): state is RoomPeerState & { cursor: NonNullable<RoomPeerState['cursor']> } =>
    Boolean(state.cursor && state.cursor.page === page)
  )
  const selections = peerSelections(room.peers, room.self?.userId ?? null)
  // Only people's pointers go idle: Piloti's moves when its tools do, and says what it does.
  const now = useTick(pointers.some((state) => !isPilotiPeer(state)), 2_000)

  /**
   * On a touch screen a mark tool is an explicit MODE, and it gives the page
   * back after one mark: one finger marks, two fingers still pinch and pan
   * (the viewer's gestures read touch events, which this surface does not
   * stop), and once the draft is placed the tool returns to navigating, so the
   * next one-finger drag scrolls the sheet instead of drawing a second box.
   */
  const backToNavigate = (pointerType: string) => {
    if (pointerType === 'touch' || pointerType === 'pen') review.setTool('select')
  }
  const cancelPress = () => {
    const press = pressRef.current
    press.cancelled = true
    setDrag(null)
    sendDraft(null)
  }
  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (tool === 'select' || event.button !== 0) return
    const press = pressRef.current
    press.pointers.add(event.pointerId)
    // A second finger: this is a pinch, not a mark.
    if (press.pointers.size > 1) {
      cancelPress()
      return
    }
    const point = pointIn(event.currentTarget, event)
    if (!point) return
    press.cancelled = false
    press.start = { ...point, clientX: event.clientX, clientY: event.clientY }
    event.currentTarget.setPointerCapture(event.pointerId)
    review.select(null)
    if (tool === 'point') return
    setDrag({ x0: point.x, y0: point.y, x1: point.x, y1: point.y })
  }
  const onPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!drag || pressRef.current.cancelled) return
    const point = pointIn(event.currentTarget, event)
    if (!point) return
    setDrag({ ...drag, x1: point.x, y1: point.y })
    // The others see the box being drawn, as it is drawn.
    sendDraft({
      x: Math.min(drag.x0, point.x),
      y: Math.min(drag.y0, point.y),
      w: Math.abs(point.x - drag.x0),
      h: Math.abs(point.y - drag.y0),
    })
  }
  const onPointerEnd = (event: ReactPointerEvent<HTMLDivElement>) => {
    const press = pressRef.current
    press.pointers.delete(event.pointerId)
    const start = press.start
    const cancelled = press.cancelled || event.type === 'pointercancel'
    if (press.pointers.size > 0) return
    press.start = null
    if (cancelled || !start) {
      press.cancelled = false
      return
    }
    if (tool === 'point') {
      // A press that travelled was a pan that landed on the page, not a point.
      if (Math.hypot(event.clientX - start.clientX, event.clientY - start.clientY) > POINT_SLOP) return
      review.setDraft({ page, shape: 'point', x: start.x, y: start.y, w: null, h: null })
      backToNavigate(event.pointerType)
      return
    }
    if (!drag) return
    const x = Math.min(drag.x0, drag.x1)
    const y = Math.min(drag.y0, drag.y1)
    const w = Math.round(Math.abs(drag.x1 - drag.x0) * 10_000) / 10_000
    const h = Math.round(Math.abs(drag.y1 - drag.y0) * 10_000) / 10_000
    setDrag(null)
    sendDraft(null)
    const next: ReviewDraft =
      w < MIN_REGION || h < MIN_REGION
        ? { page, shape: 'point', x: drag.x0, y: drag.y0, w: null, h: null }
        : { page, shape: 'region', x, y, w, h }
    // The Piloti tool: the box is a question, not a mark. A click asks about a small box around it.
    if (tool === 'ask') piloti.compose(askRegionOf(next))
    else review.setDraft(next)
    backToNavigate(event.pointerType)
  }

  const selected = marks.find((annotation) => annotation.id === selectedId) ?? null
  const draftHere = draft?.page === page ? draft : null
  // The questions asked about boxes on this page; a thread reply is asked about its mark, which is drawn already.
  const asksHere = piloti.asks.filter(
    (ask): ask is CanvasAsk & { region: NonNullable<CanvasAsk['region']> } =>
      !ask.replyInThread && ask.region?.page === page
  )
  const openAsk = focused ? (asksHere.find((ask) => ask.id === piloti.openId) ?? null) : null
  // Beside the mark's whole box, on the side with more room, top-aligned with
  // it: a card never covers what it is about. `x` is the edge it hangs from.
  const anchorOf = (place: { x: number; y: number; w: number | null }) => {
    const left = place.x
    const right = place.x + (place.w ?? 0)
    const flip = 1 - right < left
    return { x: flip ? left : right, y: place.y, flip }
  }

  return (
    <div ref={layerRef} className="pointer-events-none absolute inset-0" data-testid={`review-layer-${page}`}>
      {/* The surface a tool works on. Over the text layer, so the click that
          sets a mark never starts a selection. */}
      {focused && tool !== 'select' && (
        <div
          data-testid="review-capture"
          aria-hidden
          // A double tap here is a mark, not a zoom.
          data-zoom-tap="off"
          className="pointer-events-auto absolute inset-0 z-10 cursor-crosshair touch-none"
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerEnd}
          onPointerCancel={onPointerEnd}
        />
      )}

      {marks.map((annotation) => {
        const active = annotation.id === selectedId || annotation.id === hoveredId
        const ink = markInk(annotation)
        const proposed = annotation.status === 'proposed'
        // Piloti's mark says for whom it was set, as a tooltip and to a screen reader.
        const pilotiLine =
          annotation.authorKind === 'piloti' ? byline(annotation.createdByName, { proposal: proposed }) : undefined
        const done = !isLive(annotation)
        return (
          <div key={annotation.id} className={cn('contents', active && '[&>*]:z-20')}>
            {annotation.shape === 'region' && annotation.w && annotation.h && (
              // An outline, not a fill: the linework under a region is what it
              // is about. A tint arrives only while the mark is in hand, and
              // multiplies, so a dimension under it stays black.
              <span
                data-testid="review-region"
                aria-hidden
                className={cn(
                  'absolute rounded-[2px] border-[1.5px] mix-blend-multiply transition-[background-color,opacity] duration-quick ease-out motion-reduce:transition-none',
                  proposed && 'border-dashed',
                  done && 'opacity-40'
                )}
                style={{
                  ...box(annotation.x, annotation.y, annotation.w, annotation.h),
                  borderColor: ink,
                  backgroundColor: active ? `color-mix(in oklch, ${ink} 9%, transparent)` : 'transparent',
                }}
              />
            )}
            <span
              className={cn('pointer-events-auto absolute z-10', COMMENT_PIN_ON_POINT)}
              style={at(annotation.x, annotation.y)}
            >
              <CommentPin
                data-testid="review-pin"
                // 24px on the drawing, 44px under the finger: the pin must not
                // hide the linework it marks, and must still be hit.
                className="touch-target"
                number={annotation.number}
                color={ink}
                proposed={proposed}
                done={done}
                active={annotation.id === selectedId}
                aria-label={[
                  t('review.pinLabel', { number: annotation.number, kind: t(`annotations.kinds.${annotation.kind}`) }),
                  pilotiLine,
                ]
                  .filter(Boolean)
                  .join(' · ')}
                aria-pressed={annotation.id === selectedId}
                title={pilotiLine}
                onPointerEnter={() => review.hover(annotation.id)}
                onPointerLeave={() => review.hover(null)}
                data-peer-selected={selections.has(annotation.id) || undefined}
                onClick={(event) => {
                  event.stopPropagation()
                  if (!focused) {
                    onOpenMark?.(annotation.id)
                    return
                  }
                  review.setDraft(null)
                  review.select(annotation.id === selectedId ? null : annotation.id)
                }}
              />
            </span>
            {selections.has(annotation.id) && (
              <PeerSelection annotation={annotation} selectors={selections.get(annotation.id) ?? []} />
            )}
          </div>
        )
      })}

      {drag && (
        <span
          aria-hidden
          className="border-foreground absolute z-20 rounded-[3px] border-[1.5px] border-dashed"
          style={{
            ...box(Math.min(drag.x0, drag.x1), Math.min(drag.y0, drag.y1), Math.abs(drag.x1 - drag.x0), Math.abs(drag.y1 - drag.y0)),
            backgroundColor: 'color-mix(in oklch, var(--foreground) 6%, transparent)',
          }}
        />
      )}

      {draftHere && (
        <>
          {draftHere.shape === 'region' && draftHere.w && draftHere.h && (
            <span
              aria-hidden
              className="border-foreground absolute z-20 rounded-[2px] border-2 mix-blend-multiply"
              style={{
                ...box(draftHere.x, draftHere.y, draftHere.w, draftHere.h),
                backgroundColor: 'color-mix(in oklch, var(--foreground) 6%, transparent)',
              }}
            />
          )}
          {draftHere.shape === 'point' && (
            <span className={cn('absolute z-20', COMMENT_PIN_ON_POINT)} style={at(draftHere.x, draftHere.y)}>
              <CommentPin as="span" active color="var(--foreground)" />
            </span>
          )}
        </>
      )}

      {asksHere.map((ask) => {
        const thinking = ask.status === 'thinking' || ask.status === 'composing'
        return (
          <div key={ask.id} className="contents">
            {/* Piloti's ink, dashed: a question, not a mark. While Piloti
                works a band of light travels across it. */}
            <span
              aria-hidden
              data-testid="piloti-ask-box"
              data-status={ask.status}
              className={cn(
                'border-foreground absolute z-20 rounded-[3px] border-[1.5px] border-dashed',
                ask.status === 'thinking' && 'animate-skeleton-shimmer motion-reduce:animate-none'
              )}
              style={box(ask.region.x, ask.region.y, ask.region.w, ask.region.h)}
            />
            {ask.id !== openAsk?.id && focused && (
              <button
                type="button"
                data-testid="piloti-ask-reopen"
                aria-label={t('review.piloti.reopen')}
                title={t('review.piloti.reopen')}
                onClick={() => piloti.open(ask.id)}
                className="pointer-events-auto absolute z-30 -translate-x-1/2 -translate-y-1/2 rounded-full outline-none focus-visible:ring-2 focus-visible:ring-ring/60"
                style={at(ask.region.x + ask.region.w, ask.region.y)}
              >
                <PilotiGlyph size="xs" working={thinking} />
              </button>
            )}
          </div>
        )
      })}

      <AnimatePresence>
        {highlights.map((highlight) => (
          <motion.span
            key={highlight.key}
            data-testid="piloti-highlight"
            aria-hidden
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={motionBase}
            className="border-foreground absolute z-20 rounded-[3px] border-2 border-dashed"
            style={{
              ...box(highlight.x, highlight.y, highlight.w, highlight.h),
              backgroundColor: 'color-mix(in oklch, var(--foreground) 5%, transparent)',
            }}
          >
            {highlight.label && (
              <span className="bg-foreground text-background absolute -top-px left-0 max-w-56 -translate-y-full truncate rounded-t-[3px] px-1.5 py-0.5 text-[11px] leading-4 font-medium">
                {highlight.label}
              </span>
            )}
          </motion.span>
        ))}
      </AnimatePresence>

      {openAsk && renderAsk && (
        <div className="pointer-events-auto absolute z-40" style={at(anchorOf(openAsk.region).x, anchorOf(openAsk.region).y)}>
          {renderAsk(openAsk, anchorOf(openAsk.region))}
        </div>
      )}

      {!openAsk && focused && renderThread && (draftHere || selected) && (
        <div
          className="pointer-events-auto absolute z-40"
          style={at(anchorOf(draftHere ?? selected!).x, anchorOf(draftHere ?? selected!).y)}
        >
          {renderThread(anchorOf(draftHere ?? selected!))}
        </div>
      )}

      {/* The boxes the others are drawing right now, in their colour, with whose they are. */}
      {pointers.map((state) =>
        state.draft && !isPilotiPeer(state) ? (
          <span
            key={`draft-${state.peer.peerId}`}
            data-testid="review-peer-draft"
            aria-hidden
            className="pointer-events-none absolute z-20 rounded-[2px] border-[1.5px] border-dashed"
            style={{
              ...box(state.draft.x, state.draft.y, state.draft.w, state.draft.h),
              borderColor: identityInk(state.peer.userId),
              backgroundColor: `color-mix(in oklch, ${identityInk(state.peer.userId)} 6%, transparent)`,
            }}
          >
            <span
              className="absolute -top-px left-0 -translate-y-full rounded-t-[3px] px-1.5 py-px text-[10px] leading-4 font-medium whitespace-nowrap text-white"
              style={{ backgroundColor: identityInk(state.peer.userId) }}
            >
              {firstName(state.peer.name)}
            </span>
          </span>
        ) : null
      )}

      {size.width > 0 &&
        pointers.map((state) => (
          <GlidingCursor key={state.peer.peerId} x={state.cursor.x} y={state.cursor.y} size={size}>
            {isPilotiPeer(state) ? (
              <PilotiCursor state={state} />
            ) : (
            <LiveCursor
              color={identityInk(state.peer.userId)}
              label={state.peer.name}
              chat={state.chat}
              idle={!state.chat && state.movedAt !== null && now - state.movedAt > CURSOR_IDLE_MS}
              busy={
                state.tool === 'region' ? (
                  <SquareDashed className="size-3" aria-label={t('review.peerRegion')} />
                ) : state.tool === 'point' ? (
                  <Crosshair className="size-3" aria-label={t('review.peerPoint')} />
                ) : undefined
              }
            />
            )}
          </GlidingCursor>
        ))}
    </div>
  )
}
