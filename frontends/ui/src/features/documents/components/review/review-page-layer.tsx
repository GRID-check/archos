'use client'

import { useEffect, useRef, useState, type CSSProperties, type JSX, type PointerEvent as ReactPointerEvent } from 'react'
import { Crosshair, Sparkles, SquareDashed } from 'lucide-react'
import { motion, springGlide, useMotionToken } from '@/components/motion'
import { COMMENT_PIN_ON_POINT, CommentPin } from '@/components/ui/comment-pin'
import { identityInk, personInitials } from '@/components/ui/avatar-identity'
import { LiveCursor } from '@/components/ui/live-cursor'
import { useTranslations } from '@/i18n'
import { isLive, type AnnotationView } from '@/lib/annotations/types'
import { cn } from '@/lib/utils'
import type { DocumentReview, ReviewDraft } from '../../hooks/use-document-review'
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

/** Whose colour a mark wears: Piloti's ink, or the person who set it. */
export function markInk(annotation: Pick<AnnotationView, 'authorKind' | 'createdBy'>): string {
  return annotation.authorKind === 'piloti' ? 'var(--foreground)' : identityInk(annotation.createdBy)
}

/** What a mark's bubble holds: the setter's initials, or Piloti's glyph. */
export function MarkFace({ annotation }: { annotation: Pick<AnnotationView, 'authorKind' | 'createdByName'> }): JSX.Element {
  if (annotation.authorKind === 'piloti') return <Sparkles className="size-3" aria-hidden />
  return <>{personInitials(annotation.createdByName ?? '?')}</>
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
 * Piloti's while it walks through what it proposed.
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
}: {
  page: number
  review: DocumentReview
  focused: boolean
  /** The inline preview's way into the review: a mark was clicked. */
  onOpenMark?: (annotationId: string) => void
  /** The thread card for the selected mark or the draft, anchored here when it is on this page. */
  renderThread?: (anchor: { x: number; y: number; flip: boolean }) => JSX.Element | null
}): JSX.Element {
  const t = useTranslations('files')
  const layerRef = useRef<HTMLDivElement | null>(null)
  const [size, setSize] = useState({ width: 0, height: 0 })
  const [drag, setDrag] = useState<{ x0: number; y0: number; x1: number; y1: number } | null>(null)
  const { annotations, tool, draft, selectedId, hoveredId, tour, room, filter } = review
  const sendCursor = room.sendCursor

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
      if (point) sendCursor({ page, ...point }, tool)
    }
    const leave = () => sendCursor(null, tool)
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
    !tour?.pending.has(annotation.id) &&
    (isLive(annotation) || (focused && filter === 'closed') || annotation.id === selectedId)
  const marks = annotations.filter(visible)
  const peers = room.peers.filter((state): state is RoomPeerState & { cursor: NonNullable<RoomPeerState['cursor']> } =>
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
    if (point) setDrag({ ...drag, x1: point.x, y1: point.y })
  }
  const onPointerUp = () => {
    if (!drag) return
    const x = Math.min(drag.x0, drag.x1)
    const y = Math.min(drag.y0, drag.y1)
    const w = Math.round(Math.abs(drag.x1 - drag.x0) * 10_000) / 10_000
    const h = Math.round(Math.abs(drag.y1 - drag.y0) * 10_000) / 10_000
    setDrag(null)
    const next: ReviewDraft =
      w < MIN_REGION || h < MIN_REGION
        ? { page, shape: 'point', x: drag.x0, y: drag.y0, w: null, h: null }
        : { page, shape: 'region', x, y, w, h }
    review.setDraft(next)
  }

  const selected = marks.find((annotation) => annotation.id === selectedId) ?? null
  const draftHere = draft?.page === page ? draft : null
  // Beside the mark's pin, which is at its point or its region's top-left
  // corner: to the right, or to the left when the pin is near the page's right edge.
  const anchorOf = (place: { x: number; y: number }) => ({ x: place.x, y: place.y, flip: place.x > 0.62 })

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
              <span
                data-testid="review-region"
                aria-hidden
                className={cn(
                  'absolute rounded-[3px] border-[1.5px] transition-opacity duration-quick ease-out motion-reduce:transition-none',
                  proposed && 'border-dashed',
                  done && 'opacity-40',
                  active && 'border-2'
                )}
                style={{
                  ...box(annotation.x, annotation.y, annotation.w, annotation.h),
                  borderColor: ink,
                  backgroundColor: `color-mix(in oklch, ${ink} ${active ? 12 : 7}%, transparent)`,
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
                face={<MarkFace annotation={annotation} />}
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
              className="border-foreground absolute z-20 rounded-[3px] border-2"
              style={{
                ...box(draftHere.x, draftHere.y, draftHere.w, draftHere.h),
                backgroundColor: 'color-mix(in oklch, var(--foreground) 8%, transparent)',
              }}
            />
          )}
          <span className={cn('absolute z-20', COMMENT_PIN_ON_POINT)} style={at(draftHere.x, draftHere.y)}>
            <CommentPin as="span" face={<span className="bg-white/90 size-1.5 rounded-full" />} active />
          </span>
        </>
      )}

      {focused && renderThread && (draftHere || selected) && (
        <div
          className="pointer-events-auto absolute z-40"
          style={at(anchorOf(draftHere ?? selected!).x, anchorOf(draftHere ?? selected!).y)}
        >
          {renderThread(anchorOf(draftHere ?? selected!))}
        </div>
      )}

      {size.width > 0 &&
        peers.map((state) => (
          <GlidingCursor key={state.peer.peerId} x={state.cursor.x} y={state.cursor.y} size={size}>
            <LiveCursor
              color={identityInk(state.peer.userId)}
              label={state.peer.name}
              busy={
                state.tool === 'region' ? (
                  <SquareDashed className="size-3" aria-label={t('review.peerRegion')} />
                ) : state.tool === 'point' ? (
                  <Crosshair className="size-3" aria-label={t('review.peerPoint')} />
                ) : undefined
              }
            />
          </GlidingCursor>
        ))}

      {size.width > 0 && tour?.cursor && tour.cursor.page === page && (
        <GlidingCursor x={tour.cursor.x} y={tour.cursor.y} size={size}>
          <LiveCursor
            color="var(--foreground)"
            label="Piloti"
            icon={<Sparkles className="size-3" aria-hidden />}
            className="[&_path]:fill-foreground"
          />
        </GlidingCursor>
      )}
    </div>
  )
}
