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

/** A region smaller than this share of the page, in both directions, was a click: it becomes a point. */
const MIN_REGION = 0.012

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
  const layerRef = useRef<HTMLDivElement | null>(null)
  const [size, setSize] = useState({ width: 0, height: 0 })
  const [drag, setDrag] = useState<{ x0: number; y0: number; x1: number; y1: number } | null>(null)
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

  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (tool === 'select' || event.button !== 0) return
    const point = pointIn(event.currentTarget, event)
    if (!point) return
    event.currentTarget.setPointerCapture(event.pointerId)
    review.select(null)
    if (tool === 'point') {
      review.setDraft({ page, shape: 'point', x: point.x, y: point.y, w: null, h: null })
      return
    }
    setDrag({ x0: point.x, y0: point.y, x1: point.x, y1: point.y })
  }
  const onPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!drag) return
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
  const onPointerUp = () => {
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
          className="pointer-events-auto absolute inset-0 z-10 cursor-crosshair touch-none"
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
        />
      )}

      {marks.map((annotation) => {
        const active = annotation.id === selectedId || annotation.id === hoveredId
        const ink = markInk(annotation)
        const proposed = annotation.status === 'proposed'
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
                number={annotation.number}
                color={ink}
                proposed={proposed}
                done={done}
                active={annotation.id === selectedId}
                aria-label={t('review.pinLabel', {
                  number: annotation.number,
                  kind: t(`annotations.kinds.${annotation.kind}`),
                })}
                aria-pressed={annotation.id === selectedId}
                onPointerEnter={() => review.hover(annotation.id)}
                onPointerLeave={() => review.hover(null)}
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

      {/* The boxes the others are drawing right now, in their colour. */}
      {pointers.map((state) =>
        state.draft && !isPilotiPeer(state) ? (
          <span
            key={`draft-${state.peer.peerId}`}
            data-testid="review-peer-draft"
            aria-hidden
            className="pointer-events-none absolute rounded-[2px] border-[1.5px] border-dashed"
            style={{ ...box(state.draft.x, state.draft.y, state.draft.w, state.draft.h), borderColor: identityInk(state.peer.userId) }}
          />
        ) : null
      )}

      {size.width > 0 &&
        pointers.map((state) => (
          <GlidingCursor key={state.peer.peerId} x={state.cursor.x} y={state.cursor.y} size={size}>
            {isPilotiPeer(state) ? (
              // Piloti's own pointer, moved by its tools: ink, its spark, and
              // what it is doing as the tag, with dots while it works.
              <LiveCursor
                color="var(--foreground)"
                label={state.label || state.activity?.label || 'Piloti'}
                icon={<Sparkles className="size-3" aria-hidden />}
                busy={state.activity ? <WorkingDots className="ml-0.5" /> : undefined}
                className="[&_path]:fill-foreground"
              />
            ) : (
            <LiveCursor
              color={identityInk(state.peer.userId)}
              label={state.chat || state.peer.name}
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
