'use client'

/**
 * A page with a panel docked beside it: the page keeps working, the panel sits
 * on one edge, the reader sizes it and puts it away.
 *
 * Two surfaces are built on it, mirror images of each other: the document
 * beside the conversation (`FilePreviewBridge`, the end edge) and the Postfach
 * beside whatever page an entry opened (`InboxDock`, the start edge). The rule
 * they share: a list or a reference sits BESIDE the real surface, never a copy
 * of the surface inside the panel (ADR-0148).
 *
 * What this primitive owns, because every docked panel needs it and each one
 * that solved it alone solved it once, the hard way:
 *
 *   - THE SAME TREE, open or not. The page is always the first panel's child;
 *     opening collapses or expands the second. Switching a wrapping element for
 *     the split remounted the page under it (a chat draft, a Files selection,
 *     an upload in flight).
 *   - OPEN MEANS EXPAND, THEN RESIZE. The panel is `collapsible`, and on the
 *     journey that matters it is collapsed when `open` flips: `resize()` alone
 *     leaves a collapsed panel at zero, rendered and invisible.
 *   - BOUNDS ARE CONSTANT. Bounds derived from `open` were zero at the moment
 *     the panel was asked to open, and a mount-time default never gets a
 *     second chance.
 *   - THE WIDTH IS COMMITTED ONCE PER GESTURE (`onLayoutChanged`, after the
 *     pointer is released). Writing it per frame fed back into the layout and
 *     stopped the seam twenty pixels into every drag.
 *   - NO GESTURE IS ONE-WAY. Dragged shut, the panel is dismissed, and a tab
 *     on the edge it left by brings it back at the reader's width;
 *     double-click on the seam puts the default width back rather than
 *     collapsing it to a one-pixel sliver.
 *   - IT SLIDES, AND THE PAGE IS LAID OUT ONCE. Opening or closing glides the
 *     panel in from its edge and the page aside, as one drawer. Animating the
 *     width would re-lay out the page (a chat, a review) on every frame, so it
 *     is a FLIP: the layout lands in one step, and the panel and the page are
 *     walked there from where they were on transforms alone. Closing, the
 *     panel's content is gone with the layout, so a frozen snapshot of it
 *     (inert, hidden from assistive tech) slides out while the page takes the
 *     room back. A drag never slides (it already follows the pointer), nor a
 *     panel restored on load, nor anything under reduced motion.
 */

import type { JSX, ReactNode } from 'react'
import { useLayoutEffect, useRef, useState } from 'react'
import { usePanelRef } from 'react-resizable-panels'
import { PanelLeft, PanelRight } from 'lucide-react'

import { asWebAnimation, motionDeliberateEntrance, motionSheetExit, usePrefersReducedMotion } from '@/components/motion'
import { FOCUS_RING } from '@/components/ui/focus-ring'
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from '@/components/ui/resizable'
import { cn } from '@/lib/utils'

export interface DockedSplitProps {
  /** The group's id; the panels are `<id>-page` and `<id>-panel`. */
  id: string
  /** The edge the panel is docked to. */
  side: 'start' | 'end'
  /** Whether the panel is in the layout. Closed, it is collapsed to zero and the page has the row. */
  open: boolean
  /** The reader's width in pixels, as last committed. Read when the panel opens. */
  width: number
  minWidth: number
  maxWidth: number
  /** The width a double-click on the seam puts back. */
  defaultWidth: () => number
  /** A width the reader chose, once per gesture. */
  onWidthChange: (width: number) => void
  /** The reader dragged the seam shut. */
  onDismiss: () => void
  /**
   * A stored width to adopt before the panel is first sized, or null to keep
   * `width`. Read once, at mount: the store may only know it on the client.
   */
  restoreWidth?: () => number | null
  /** Names the seam for a keyboard reader, whose arrow keys resize the panel. */
  resizeLabel: string
  /** While something can be brought back: the tab on the panel's edge that does it. */
  restore?: { label: string; onRestore: () => void; testId?: string } | null
  /** The docked panel's content. */
  panel: ReactNode
  /** Classes on the docked panel. */
  panelClassName?: string
  /** Classes on the page's panel (a shell lays its `<main>` out as a column there). */
  pageClassName?: string
  /**
   * Whether opening and closing glide (default). False for a change the
   * reader did not make, such as a panel restored after a reload.
   */
  slide?: boolean
  /** The page. */
  children: ReactNode
}

export function DockedSplit({
  id,
  side,
  open,
  width,
  minWidth,
  maxWidth,
  defaultWidth,
  onWidthChange,
  onDismiss,
  restoreWidth,
  resizeLabel,
  restore = null,
  panel,
  panelClassName,
  pageClassName,
  slide = true,
  children,
}: DockedSplitProps): JSX.Element {
  const panelRef = usePanelRef()
  const pageElementRef = useRef<HTMLDivElement | null>(null)
  const panelElementRef = useRef<HTMLDivElement | null>(null)
  const reducedMotion = usePrefersReducedMotion()
  const settledRef = useRef(false)
  // The content as it was while open, rendered for the one commit in which the
  // panel closes, so the slide-out has something to take a snapshot of.
  const lastPanelRef = useRef<ReactNode>(null)
  const [wasOpen, setWasOpen] = useState(open)
  const [leaving, setLeaving] = useState(false)
  if (wasOpen !== open) {
    setWasOpen(open)
    setLeaving(!open)
  }
  const shownPanel = open ? panel : leaving ? lastPanelRef.current : null
  useLayoutEffect(() => {
    if (open && panel) lastPanelRef.current = panel
  })
  const widthRef = useRef(width)
  widthRef.current = width
  // A mount-time value, captured once: `defaultSize` is the library's mount
  // input, and feeding it the live width recomputed the layout under the drag.
  const mountWidthRef = useRef(width)

  // The remembered width, adopted before the panel is first sized; the `open`
  // effect below, same commit, then sizes to it rather than to the default.
  const restoredRef = useRef(false)
  useLayoutEffect(() => {
    if (restoredRef.current || !restoreWidth) return
    restoredRef.current = true
    const stored = restoreWidth()
    if (stored === null) return
    widthRef.current = stored
    panelRef.current?.resize(stored)
  }, [restoreWidth, panelRef])

  useLayoutEffect(() => {
    const docked = panelRef.current
    if (!docked) return
    const panelElement = panelElementRef.current
    const glides = slide && settledRef.current && !reducedMotion
    settledRef.current = true
    if (!open) {
      const travel = canAnimate(panelElement) ? panelElement.getBoundingClientRect().width : 0
      const snapshot = glides && panelElement && travel > 0 ? snapshotOf(panelElement) : null
      docked.collapse()
      setLeaving(false)
      if (snapshot) slideClosed(snapshot, pageElementRef.current, side, travel)
      return
    }
    docked.expand()
    docked.resize(widthRef.current)
    if (glides && canAnimate(panelElement)) slideOpen(panelElement, pageElementRef.current, side, widthRef.current)
    // `slide` and reduced motion are read as they stand when `open` changes.
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [open, panelRef])

  const pagePanel = (
    <ResizablePanel
      key={`${id}-page`}
      id={`${id}-page`}
      elementRef={pageElementRef}
      // No `defaultSize`: the page takes whatever the docked panel leaves. Two
      // defaults summing past the row made the library collapse the panel
      // whenever it could measure at mount, and `expand()` could not undo it.
      minSize="40"
      className={cn('relative min-h-0 min-w-0 overflow-hidden', pageClassName)}
    >
      {children}
      {restore && (
        <button
          type="button"
          data-testid={restore.testId}
          onClick={restore.onRestore}
          aria-label={restore.label}
          title={restore.label}
          className={cn(
            'group/restore bg-card text-muted-foreground hover:text-foreground hover:bg-accent border-base absolute top-1/2 z-20 flex h-16 w-6 -translate-y-1/2 items-center justify-center border shadow-sm',
            side === 'end' ? 'right-0 rounded-l-lg border-r-0' : 'left-0 rounded-r-lg border-l-0',
            'transition-colors duration-quick ease-out motion-reduce:transition-none',
            side === 'end'
              ? 'animate-in fade-in-0 slide-in-from-right-2 duration-base ease-entrance motion-reduce:animate-none'
              : 'animate-in fade-in-0 slide-in-from-left-2 duration-base ease-entrance motion-reduce:animate-none',
            FOCUS_RING,
          )}
        >
          {/* The panel's own glyph, leaning out on approach: a tab you pull. */}
          {side === 'end' ? (
            <PanelRight
              className="size-3.5 transition-transform duration-quick ease-out group-hover/restore:-translate-x-px motion-reduce:transition-none"
              aria-hidden
            />
          ) : (
            <PanelLeft
              className="size-3.5 transition-transform duration-quick ease-out group-hover/restore:translate-x-px motion-reduce:transition-none"
              aria-hidden
            />
          )}
        </button>
      )}
    </ResizablePanel>
  )

  const seam = open ? (
    <ResizableHandle
      key={`${id}-handle`}
      withHandle
      aria-label={resizeLabel}
      disableDoubleClick
      onDoubleClick={() => {
        panelRef.current?.expand()
        const next = defaultWidth()
        panelRef.current?.resize(next)
        onWidthChange(next)
      }}
    />
  ) : null

  const dockedPanel = (
    <ResizablePanel
      key={`${id}-panel`}
      id={`${id}-panel`}
      panelRef={panelRef}
      elementRef={panelElementRef}
      defaultSize={mountWidthRef.current}
      minSize={minWidth}
      maxSize={maxWidth}
      collapsible
      collapsedSize={0}
      className={cn('min-h-0 min-w-0', panelClassName)}
      groupResizeBehavior="preserve-pixel-size"
    >
      {shownPanel}
    </ResizablePanel>
  )

  return (
    <ResizablePanelGroup
      orientation="horizontal"
      // Clipped, so a page walked aside by the slide never scrolls the window.
      className="h-full min-h-0 min-w-0 flex-1 overflow-hidden"
      id={id}
      onLayoutChanged={(_layout, meta) => {
        if (!meta.isUserInteraction) return
        const size = panelRef.current?.getSize()
        if (!size) return
        if (size.inPixels > 0) {
          onWidthChange(size.inPixels)
          return
        }
        // Dragged shut: the panel is collapsible, so pulling the seam past its
        // minimum is always reachable, and a sliver left there would strand it.
        onDismiss()
      }}
    >
      {side === 'end' ? [pagePanel, seam, dockedPanel] : [dockedPanel, seam, pagePanel]}
    </ResizablePanelGroup>
  )
}

/** Whether this engine can play a Web Animation on the element; where not, the layout simply lands. */
const canAnimate = (element: HTMLElement | null): element is HTMLElement => typeof element?.animate === 'function'

/** The direction the panel leaves by: toward its own edge. */
const outward = (side: 'start' | 'end'): number => (side === 'start' ? -1 : 1)

/**
 * Walks the panel in from its edge and the page aside from where it stood.
 * The layout has already landed; these only play the way there. The panel is
 * lifted above the page for the move, since the page starts over it.
 */
function slideOpen(panel: HTMLElement | null, page: HTMLElement | null, side: 'start' | 'end', travel: number): void {
  const options = asWebAnimation(motionDeliberateEntrance)
  const from = outward(side) * travel
  if (panel) {
    panel.style.zIndex = '1'
    panel.style.position = 'relative'
    const move = panel.animate([{ transform: `translateX(${from}px)` }, { transform: 'translateX(0)' }], options)
    move.onfinish = move.oncancel = () => {
      panel.style.zIndex = ''
      panel.style.position = ''
    }
  }
  // The start edge moves the page; at the end edge the page's left stays put.
  if (page && side === 'start') page.animate([{ transform: `translateX(${from}px)` }, { transform: 'translateX(0)' }], options)
}

/** Slides the snapshot out by its edge while the page takes the room back, then drops it. */
function slideClosed(snapshot: HTMLElement, page: HTMLElement | null, side: 'start' | 'end', travel: number): void {
  const options = asWebAnimation(motionSheetExit)
  const to = outward(side) * travel
  const move = snapshot.animate([{ transform: 'translateX(0)' }, { transform: `translateX(${to}px)` }], options)
  move.onfinish = move.oncancel = () => snapshot.remove()
  if (page && side === 'start') page.animate([{ transform: `translateX(${travel}px)` }, { transform: 'translateX(0)' }], options)
}

/**
 * A still image of the panel, in the DOM for the length of its slide-out:
 * where the panel stood, above the page, inert and hidden from assistive tech,
 * its ids and test ids taken off so nothing can find it as the panel.
 */
function snapshotOf(panel: HTMLElement): HTMLElement {
  const box = panel.getBoundingClientRect()
  const snapshot = panel.cloneNode(true) as HTMLElement
  for (const node of [snapshot, ...snapshot.querySelectorAll<HTMLElement>('[id], [data-testid]')]) {
    node.removeAttribute('id')
    node.removeAttribute('data-testid')
  }
  snapshot.setAttribute('aria-hidden', 'true')
  snapshot.inert = true
  Object.assign(snapshot.style, {
    position: 'fixed',
    left: `${box.left}px`,
    top: `${box.top}px`,
    width: `${box.width}px`,
    height: `${box.height}px`,
    margin: '0',
    pointerEvents: 'none',
    zIndex: '30',
  })
  document.body.append(snapshot)
  return snapshot
}
