'use client'

/**
 * A page with a panel docked beside it: the page keeps working, the panel sits
 * on one edge, the reader sizes it and puts it away.
 *
 * Two surfaces are built on it, mirror images of each other: the document
 * beside the conversation (`FilePreviewBridge`, the end edge) and the Postfach
 * beside whatever page an entry opened (`InboxDock`, the start edge). The rule
 * they share: a list or a reference sits BESIDE the real surface, never a copy
 * of the surface inside the panel (ADR-0153).
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
 */

import type { JSX, ReactNode } from 'react'
import { useLayoutEffect, useRef } from 'react'
import { usePanelRef } from 'react-resizable-panels'
import { PanelLeft, PanelRight } from 'lucide-react'

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
  children,
}: DockedSplitProps): JSX.Element {
  const panelRef = usePanelRef()
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
    if (!open) {
      docked.collapse()
      return
    }
    docked.expand()
    docked.resize(widthRef.current)
  }, [open, panelRef])

  const pagePanel = (
    <ResizablePanel
      key={`${id}-page`}
      id={`${id}-page`}
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
      defaultSize={mountWidthRef.current}
      minSize={minWidth}
      maxSize={maxWidth}
      collapsible
      collapsedSize={0}
      className={cn('min-h-0 min-w-0', panelClassName)}
      groupResizeBehavior="preserve-pixel-size"
    >
      {panel}
    </ResizablePanel>
  )

  return (
    <ResizablePanelGroup
      orientation="horizontal"
      className="h-full min-h-0 min-w-0 flex-1"
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
