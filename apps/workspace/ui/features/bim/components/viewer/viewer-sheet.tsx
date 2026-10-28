'use client'

/**
 * What slides up from the bottom edge, leaving the building above it.
 *
 * The desktop selection card is 288 px wide and parked at the top right. On a
 * 393 px phone that leaves a 93 px strip of building — the card WAS the screen.
 * A phone wants the shape every native viewer settled on: a sheet that rises
 * from the thumb's side, shows the one thing you asked about in a short
 * "peek", and grows only when you pull it. The model stays visible and
 * orbitable above it, because the sheet is not modal and has no scrim.
 *
 * ## Two sizes, not a drag-anywhere sheet
 *
 * `peek` shows the header (what is this) and the footer (what can I do with
 * it), and nothing between — about a fifth of the screen. `full` adds the
 * scrolling body, capped at 60 % of the screen so a sliver of building always
 * stays. A freely draggable height needs a spring, a velocity model and a
 * decision about where it comes to rest; two stops need none of those and are
 * what a thumb on a moving train can hit. A sheet with no `snap` is a plain
 * list sheet: it is always the one size and only offers to close.
 *
 * ## The handle owns its gesture
 *
 * The handle region is `touch-action: none`: that is the Touch rule's one
 * exception (a surface that genuinely owns a gesture), and the region is a
 * 44 px strip with nothing scrollable under it, so no finger is stranded.
 * Everything else in the sheet — the body above all — keeps the browser's own
 * scroll. A tap on the handle toggles; a swipe up expands; a swipe down
 * collapses, and from the smallest size dismisses.
 *
 * Under a landscape phone there is no room for a bottom sheet (393 px of
 * height), so `placement="side"` renders the same content as the panel the
 * desktop uses, narrower and anchored by the caller.
 */

import type { JSX } from 'react'
import {
  useId,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from 'react'
import { X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { ViewerPanel, ViewerSectionBody } from './viewer-panel'
import { ViewerSurface } from './viewer-surface'

export type ViewerSheetSnap = 'peek' | 'full'

/** Travel, in px, past which a vertical drag is a swipe and not a tap. */
export const SHEET_SWIPE_PX = 32

/** What a finished handle gesture means. Pure, so it can be tested as a table. */
export function sheetGesture(
  travelY: number,
  snap: ViewerSheetSnap | undefined
): 'toggle' | 'expand' | 'collapse' | 'dismiss' | 'none' {
  if (Math.abs(travelY) < SHEET_SWIPE_PX) return snap === undefined ? 'none' : 'toggle'
  if (travelY < 0) return snap === 'peek' ? 'expand' : 'none'
  return snap === 'full' ? 'collapse' : 'dismiss'
}

export interface ViewerSheetCollapse {
  snap: ViewerSheetSnap
  onSnapChange: (snap: ViewerSheetSnap) => void
  expandLabel: string
  collapseLabel: string
}

export interface ViewerSheetProps {
  title: string
  /** One line under the title: what kind of thing this is, where it sits. */
  subtitle?: ReactNode
  closeLabel: string
  onClose: () => void
  /** Present for a sheet with a peek size; absent for a plain list sheet. */
  collapse?: ViewerSheetCollapse
  /** `bottom` is the portrait phone sheet; `side` the landscape phone panel. */
  placement?: 'bottom' | 'side'
  children: ReactNode
  /** Pinned below the body, and the whole of what a peek shows besides the header. */
  footer?: ReactNode
  /** Overrides the `p-3` body — a list of rows brings its own inset. */
  bodyClassName?: string
  className?: string
}

export function ViewerSheet({
  title,
  subtitle,
  closeLabel,
  onClose,
  collapse,
  placement = 'bottom',
  children,
  footer,
  bodyClassName,
  className,
}: ViewerSheetProps): JSX.Element {
  if (placement === 'side') {
    return (
      <ViewerPanel
        title={title}
        subtitle={subtitle}
        closeLabel={closeLabel}
        onClose={onClose}
        footer={footer}
        bodyClassName={bodyClassName}
        // Narrower than the desktop card: the tool column takes the left edge
        // and the building needs the middle of an 852 px screen.
        className={cn('w-[min(20rem,42vw)]', className)}
      >
        {children}
      </ViewerPanel>
    )
  }
  return (
    <BottomSheet
      title={title}
      subtitle={subtitle}
      closeLabel={closeLabel}
      onClose={onClose}
      collapse={collapse}
      footer={footer}
      bodyClassName={bodyClassName}
      className={className}
    >
      {children}
    </BottomSheet>
  )
}

function BottomSheet({
  title,
  subtitle,
  closeLabel,
  onClose,
  collapse,
  children,
  footer,
  bodyClassName,
  className,
}: Omit<ViewerSheetProps, 'placement'>): JSX.Element {
  const snap = collapse?.snap
  const expanded = snap !== 'peek'
  const bodyId = `${useId()}-body`

  // The finger's travel while it is down, so the sheet FOLLOWS it. A sheet that
  // only reacts on release feels like a button; one that tracks the hand feels
  // like paper.
  const [travel, setTravel] = useState(0)
  const origin = useRef<{ y: number; pointerId: number } | null>(null)
  const swallowClick = useRef(false)

  const down = (event: ReactPointerEvent<HTMLElement>): void => {
    origin.current = { y: event.clientY, pointerId: event.pointerId }
    swallowClick.current = false
    event.currentTarget.setPointerCapture?.(event.pointerId)
  }
  const move = (event: ReactPointerEvent<HTMLElement>): void => {
    if (!origin.current || origin.current.pointerId !== event.pointerId) return
    const dy = event.clientY - origin.current.y
    if (Math.abs(dy) >= SHEET_SWIPE_PX) swallowClick.current = true
    // Only downward travel moves the sheet: it has nowhere to go up to.
    setTravel(Math.max(0, dy))
  }
  const finish = (event: ReactPointerEvent<HTMLElement>, cancelled: boolean): void => {
    const start = origin.current
    origin.current = null
    setTravel(0)
    if (!start || start.pointerId !== event.pointerId || cancelled) return
    const gesture = sheetGesture(event.clientY - start.y, snap)
    // A swipe is followed by the `click` the browser synthesises on release; it
    // must not toggle what the swipe just set.
    if (gesture !== 'toggle' && gesture !== 'none') swallowClick.current = true
    if (gesture === 'expand') collapse?.onSnapChange('full')
    else if (gesture === 'collapse') collapse?.onSnapChange('peek')
    else if (gesture === 'dismiss') onClose()
    // A toggle is left to the button's own `click`, which also covers the
    // keyboard; handling it here as well would flip it twice.
  }

  const handleProps = {
    onPointerDown: down,
    onPointerMove: move,
    onPointerUp: (event: ReactPointerEvent<HTMLElement>) => finish(event, false),
    onPointerCancel: (event: ReactPointerEvent<HTMLElement>) => finish(event, true),
  }

  const bar = (
    <span aria-hidden="true" className="bg-foreground/20 mx-auto mb-2 block h-1 w-9 rounded-full" />
  )
  const titleClass = 'block text-sm font-semibold text-foreground line-clamp-2 break-words'
  const subtitleNode = subtitle && (
    <span className="text-muted-foreground mt-0.5 line-clamp-2 block break-words text-xs">
      {subtitle}
    </span>
  )

  return (
    <ViewerSurface
      aria-label={title}
      role="complementary"
      data-snap={snap ?? 'static'}
      style={travel > 0 ? { transform: `translateY(${travel}px)`, transition: 'none' } : undefined}
      className={cn(
        'pointer-events-auto flex w-full max-w-lg flex-col overflow-hidden',
        expanded ? 'max-h-[min(60dvh,34rem)]' : 'max-h-[40dvh]',
        'animate-in fade-in-0 slide-in-from-bottom-3 duration-base ease-entrance motion-reduce:animate-none',
        className
      )}
    >
      <div className="flex shrink-0 items-start">
        {collapse ? (
          <button
            type="button"
            aria-expanded={expanded}
            aria-controls={bodyId}
            aria-label={expanded ? collapse.collapseLabel : collapse.expandLabel}
            onClick={() => {
              // A swipe that ended in a snap must not also fire the toggle.
              if (swallowClick.current) {
                swallowClick.current = false
                return
              }
              collapse.onSnapChange(expanded ? 'peek' : 'full')
            }}
            className="focus-visible:ring-ring/60 min-h-11 min-w-0 flex-1 touch-none px-3 pb-2 pt-2 text-left outline-none focus-visible:ring-2 focus-visible:ring-inset"
            {...handleProps}
          >
            {bar}
            <span className={titleClass}>{title}</span>
            {subtitleNode}
          </button>
        ) : (
          <div
            className="min-h-11 min-w-0 flex-1 touch-none px-3 pb-2 pt-2 text-left"
            {...handleProps}
          >
            {bar}
            <h2 className={titleClass}>{title}</h2>
            {subtitleNode}
          </div>
        )}
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="mr-1 mt-1 shrink-0 rounded-md"
          onClick={onClose}
          aria-label={closeLabel}
        >
          <X className="size-4" aria-hidden="true" />
        </Button>
      </div>
      <ViewerSectionBody
        id={bodyId}
        // `hidden` in a peek: unmounting would throw away the scroll offset and
        // the open `<details>` the reader left, and the body is cheap.
        hidden={!expanded}
        className={cn(
          'border-border min-h-0 flex-1 overflow-y-auto overscroll-contain border-t',
          bodyClassName
        )}
      >
        {children}
      </ViewerSectionBody>
      {footer && <div className="border-border border-t p-3">{footer}</div>}
    </ViewerSurface>
  )
}
