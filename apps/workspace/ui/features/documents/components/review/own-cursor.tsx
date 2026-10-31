'use client'

import { useEffect, useRef, type JSX, type RefObject } from 'react'
import { Crosshair, Sparkles, SquareDashed } from 'lucide-react'
import { identityInk } from '@/components/ui/avatar-identity'
import { LiveCursor } from '@/components/ui/live-cursor'
import { useMediaQuery } from '@/hooks/use-media-query'
import type { ReviewTool } from '../../hooks/use-document-review'

/**
 * Where the system pointer stays over a page: what a hand works with rather
 * than points at (a pin, a field, a button, a menu) and the cards that open on
 * the sheet (`data-placement`, the thread and Piloti's answer). Over these the
 * reader keeps the pointer their system gives them.
 */
const SYSTEM_POINTER =
  'button, a[href], input, textarea, select, label, [contenteditable=""], [contenteditable="true"], [role="button"], [role="dialog"], [role="menu"], [role="listbox"], [role="slider"], [data-placement]'

/**
 * The canvas's classes for the drawn pointer: while it is shown (the canvas
 * carries `data-own-cursor`), no element under it draws the system's. The
 * attribute is only set while the pointer is over a page and none of
 * {@link SYSTEM_POINTER}, so a field or a pin never loses its own.
 */
export const OWN_CURSOR_ZONE = 'data-[own-cursor]:cursor-none! [&[data-own-cursor]_*]:cursor-none!'

/** Whether the drawn pointer stands for the reader at `target`: on a page of `root`, over nothing a hand works with. */
export function ownCursorShows(target: EventTarget | null, root: Element): boolean {
  if (!(target instanceof Element) || !root.contains(target)) return false
  const page = target.closest('[data-page]')
  if (!page || !root.contains(page)) return false
  // A match around the canvas (the review is itself a dialog) is the frame, not a control on the page.
  const hit = target.closest(SYSTEM_POINTER)
  return hit === null || hit.contains(root)
}

/** The tool in hand, as a glyph beside the arrow: a mark's tools aim, so the reader sees which aim. */
function toolBadge(tool: ReviewTool): JSX.Element | undefined {
  if (tool === 'point') return <Crosshair data-own-cursor-tool="point" />
  if (tool === 'region') return <SquareDashed data-own-cursor-tool="region" />
  if (tool === 'ask') return <Sparkles data-own-cursor-tool="ask" />
  return undefined
}

/**
 * The reader's own pointer over the review's pages, drawn the way the room
 * draws it for everyone else (`LiveCursor`, the arrow in their `identityInk`):
 * what they see of their hand is what their colleagues see of it. No name
 * tag, which is for telling people apart; the tool in hand rides beside the
 * arrow instead, and the arrow's tip is the point, so aiming loses nothing.
 *
 * It moves on `transform` alone, written once per animation frame from the
 * last `pointermove`: no React render per move and no glide (a glide is how
 * others' pointers bridge the room's 80 ms samples, and on one's own hand it
 * is lag), so it trails the real pointer by at most a frame and needs nothing
 * for reduced motion. It hides off the pages, over controls and cards, when
 * the pointer leaves the canvas, and for a finger; on a touch screen it is
 * never drawn. Cursor chat is untouched: the bubble opens at this pointer, as
 * it opens at this reader's arrow on everyone else's screen.
 */
export function OwnCursor({
  canvas,
  userId,
  name,
  tool,
}: {
  /** The review's canvas: the pages inside it get the drawn pointer, and it carries {@link OWN_CURSOR_ZONE}. */
  canvas: RefObject<HTMLElement | null>
  userId: string | null
  name: string
  tool: ReviewTool
}): JSX.Element | null {
  const coarse = useMediaQuery('(pointer: coarse)')
  const node = useRef<HTMLSpanElement | null>(null)

  useEffect(() => {
    const root = canvas.current
    const self = node.current
    if (coarse || !root || !self) return
    let frame = 0
    let shown = false
    let want = false
    let at = { x: 0, y: 0 }
    const draw = () => {
      frame = 0
      if (want) {
        // Read before the write, once a frame: the canvas can move (a dialog, a panel opening beside it).
        const box = root.getBoundingClientRect()
        self.style.transform = `translate3d(${at.x - box.left}px, ${at.y - box.top}px, 0)`
      }
      if (want === shown) return
      shown = want
      self.style.visibility = want ? 'visible' : 'hidden'
      root.toggleAttribute('data-own-cursor', want)
    }
    const ask = (next: boolean) => {
      want = next
      if (!frame) frame = requestAnimationFrame(draw)
    }
    const move = (event: PointerEvent) => {
      at = { x: event.clientX, y: event.clientY }
      ask(event.pointerType !== 'touch' && ownCursorShows(event.target, root))
    }
    const leave = () => ask(false)
    root.addEventListener('pointermove', move)
    root.addEventListener('pointerleave', leave)
    return () => {
      root.removeEventListener('pointermove', move)
      root.removeEventListener('pointerleave', leave)
      cancelAnimationFrame(frame)
      root.removeAttribute('data-own-cursor')
    }
  }, [canvas, coarse])

  if (coarse) return null
  return (
    <span
      ref={node}
      aria-hidden
      data-testid="own-cursor"
      className="pointer-events-none absolute top-0 left-0 z-40 will-change-transform"
      style={{ visibility: 'hidden' }}
    >
      <LiveCursor color={identityInk(userId ?? 'me')} label={name} tag={false} badge={toolBadge(tool)} />
    </span>
  )
}
