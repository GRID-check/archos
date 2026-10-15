'use client'

import type { JSX } from 'react'
import * as React from 'react'
import * as DialogPrimitive from '@radix-ui/react-dialog'
import { X } from 'lucide-react'

import { cn } from '@/lib/utils'
import { FOCUS_RING } from '@/components/ui/focus-ring'
import {
  AnimatePresence,
  motion,
  motionEntrance,
  motionSheetEnter,
  motionSheetExit,
  springGlide,
} from '@/components/motion'
import { useDragControls, type PanInfo } from 'motion/react'
import { pullDismisses } from '@/components/ui/sheet-pull'

/**
 * Page sheet — a near-fullscreen surface that rises OVER the current page
 * instead of replacing it.
 *
 * The modal interrupts to ask a question and the side sheet shows the detail of
 * a row; this is the third intent: a whole PLACE (the Archiv, the Postfach)
 * that is independent of wherever the reader is standing. The page they came
 * from stays visible at the dimmed edges, which is the one visual claim a full
 * navigation cannot make: closing this returns you exactly there.
 *
 * Built on the same Radix Dialog as the other two — identical focus trap,
 * escape handling and scroll locking, no new dependency. On every viewport the
 * panel is bottom-anchored with a sliver of app visible above it (iOS
 * page-sheet style); from `md` up it also leaves side margins and is capped
 * and centred on very wide monitors.
 *
 * THE SLIDE, AND THE PULL. Travel is the panel's own height, so any spring's
 * overshoot percentage is out of budget by construction (see the design
 * language's Motion vocabulary): a tween on `--ease-entrance` at
 * `--motion-deliberate`, exit one step shorter on `--ease-exit`. The panel
 * animates through motion.dev rather than CSS keyframes because the sheet is
 * also DRAGGABLE — grab the top band and pull down to dismiss, on touch and
 * pointer alike. A CSS entrance keyframe and a drag gesture both write
 * `transform`, and whichever loses jumps; one motion pipeline means the pull,
 * the snap-back and the dismissal all share the same transform.
 *
 * The snap-back after an uncommitted pull is `springGlide` — the one earned
 * spring here. It is the reader's own gesture handed back (continuation), and
 * its travel is wherever the finger let go, which is exactly the unbounded
 * case that spring is calibrated for.
 */

/**
 * The panel's geometry, shared with {@link PageSheetSkeleton} in
 * `components/shell` so the loading state cannot drift to a different box than
 * the sheet that replaces it.
 *
 * Bottom-anchored on every viewport: the visible sliver of app above the top
 * edge is what says "this is a sheet over your page, and it pulls down".
 * `border-b-0` because the bottom edge is the screen edge — a hairline there
 * reads as a gap.
 *
 * The left and right insets are the panel's: on a phone on its side the
 * Dynamic Island sits on one long edge, about 59px deep, and the panel runs
 * edge to edge there (the side margins start at `md`, which a phone never
 * reaches). The paper still bleeds to the screen edge; only the content steps
 * in. The bottom inset is the content's, because only the content knows
 * whether its last row is a pinned bar that should run under the home
 * indicator (the history sheet's) or a list that should scroll clear of it.
 */
export const PAGE_SHEET_OVERLAY_CLASS = 'bg-overlay fixed inset-0 z-50 backdrop-blur-sm'
export const PAGE_SHEET_PANEL_CLASS =
  'bg-background fixed inset-x-0 bottom-0 top-[max(0.75rem,env(safe-area-inset-top))] z-50 flex flex-col overflow-hidden rounded-t-2xl border border-b-0 pl-[env(safe-area-inset-left)] pr-[env(safe-area-inset-right)] shadow-xl outline-none md:inset-x-5 md:top-5 md:mx-auto'

/**
 * How wide the panel may grow from `md` up. One width: a page sheet is a whole
 * PLACE, and every place caps and centres its own reading column inside it
 * (the Inbox and the history sheet both run a `max-w-3xl` column). A per-sheet
 * `reading` width existed and lost its last consumer to that pattern.
 */
const PANEL_WIDTH = 'md:max-w-[1400px]'

interface PageSheetProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** The place's name — rendered as the header title and announced to AT. */
  title: string
  /** One line under the title; also the dialog's accessible description. */
  subtitle?: string
  /** Accessible label for the close button (i18n'd by the caller). */
  closeLabel: string
  /** Extra header controls, right-aligned beside the close button. */
  headerActions?: React.ReactNode
  /**
   * Skip the sheet's own header band. For content that already carries a full
   * identity row of its own (the Archiv workspace) a second title bar would
   * say the same name twice — instead the title goes sr-only and the content
   * hosts a {@link PageSheetClose} inside its existing row. The grabber band
   * stays: it is the sheet's chrome, not the content's.
   */
  headerless?: boolean
  /**
   * Where focus lands when the sheet opens, instead of Radix's default (the
   * first focusable). The history sheet hands it to its search field — finding
   * a past chat is why the sheet gets opened.
   */
  initialFocusRef?: React.RefObject<HTMLElement | null>
  /**
   * Fires once the exit animation has fully played. `RoutePageSheet` navigates
   * HERE rather than on close, so the slide-out is seen instead of being cut
   * off by the route unmounting beneath it.
   */
  onExitComplete?: () => void
  /** Applied to the body region between header and bottom edge. */
  bodyClassName?: string
  children: React.ReactNode
}

export function PageSheet({
  open,
  onOpenChange,
  title,
  subtitle,
  closeLabel,
  headerActions,
  headerless = false,
  initialFocusRef,
  onExitComplete,
  bodyClassName,
  children,
}: PageSheetProps): JSX.Element {
  const dragControls = useDragControls()
  // Whether the current press turned into a pull. The grabber's pill is a
  // close button AND the most natural place to start a pull, and a pull that
  // falls short still ends in a click on the pill (it rode along under the
  // finger), which must not close the sheet the reader just chose to keep.
  const pulledRef = React.useRef(false)

  // The drag hot zone is the grabber band plus (when present) the header —
  // matching where a hand naturally goes to move a sheet. Interactive children
  // (the close X, header actions) keep their clicks: a press that starts on
  // one of them never becomes a pull. The grabber's own pill is the exception:
  // a press there may become either.
  const startDrag = React.useCallback(
    (event: React.PointerEvent) => {
      const target = event.target as HTMLElement
      pulledRef.current = false
      const onGrabber = target.closest('[data-slot="page-sheet-grabber"]') !== null
      if (!onGrabber && target.closest('button, a, input, select, textarea, [role="button"]')) return
      dragControls.start(event)
    },
    [dragControls]
  )

  const handleDragEnd = React.useCallback(
    (_event: MouseEvent | TouchEvent | PointerEvent, info: PanInfo) => {
      if (pullDismisses(info.offset.y, info.velocity.y)) onOpenChange(false)
    },
    [onOpenChange]
  )

  return (
    <DialogPrimitive.Root open={open} onOpenChange={onOpenChange}>
      <AnimatePresence onExitComplete={onExitComplete}>
        {open && (
          <DialogPrimitive.Portal forceMount>
            <DialogPrimitive.Overlay asChild forceMount>
              <motion.div
                className={PAGE_SHEET_OVERLAY_CLASS}
                initial={{ opacity: 0 }}
                animate={{ opacity: 1, transition: motionEntrance }}
                exit={{ opacity: 0, transition: motionSheetExit }}
              />
            </DialogPrimitive.Overlay>
            <DialogPrimitive.Content
              asChild
              forceMount
              // Focus lands on the panel itself unless the caller directs it
              // (the history sheet's search field). Radix's default — the first
              // focusable — is the grabber's pill, and a focus ring around
              // the grabber on every open reads as the sheet asking to be
              // closed. Tab still reaches every control in order.
              onOpenAutoFocus={(event) => {
                event.preventDefault()
                if (initialFocusRef) initialFocusRef.current?.focus()
                else (event.currentTarget as HTMLElement | null)?.focus()
              }}
            >
              <motion.div
                className={cn(PAGE_SHEET_PANEL_CLASS, PANEL_WIDTH)}
                initial={{ y: '100%' }}
                animate={{ y: 0, transition: motionSheetEnter }}
                exit={{ y: '100%', transition: motionSheetExit }}
                drag="y"
                dragListener={false}
                dragControls={dragControls}
                // Zero-size constraint box at rest: any travel is "outside", so
                // upward is refused outright (elastic 0) and downward follows
                // the finger 1:1 (elastic 1) — the sheet is IN the hand, not
                // rubber-banding against it.
                dragConstraints={{ top: 0, bottom: 0 }}
                dragElastic={{ top: 0, bottom: 1 }}
                dragTransition={{
                  bounceStiffness: springGlide.stiffness,
                  bounceDamping: springGlide.damping,
                }}
                onDragStart={() => {
                  pulledRef.current = true
                }}
                onDragEnd={handleDragEnd}
              >
                <PageSheetGrabber label={closeLabel} onPointerDown={startDrag} pulledRef={pulledRef} />
                {headerless ? (
                  <>
                    <DialogPrimitive.Title data-slot="page-sheet-title" className="sr-only">
                      {title}
                    </DialogPrimitive.Title>
                    <DialogPrimitive.Description className="sr-only">
                      {subtitle ?? title}
                    </DialogPrimitive.Description>
                  </>
                ) : (
                  <header
                    className="border-border flex shrink-0 cursor-grab touch-none items-start justify-between gap-4 border-b px-4 pb-4 pt-2 select-none active:cursor-grabbing pointer-coarse:pt-0 md:px-8 md:pb-5 md:pt-3"
                    onPointerDown={startDrag}
                  >
                    <div className="flex min-w-0 flex-col gap-0.5">
                      <DialogPrimitive.Title
                        data-slot="page-sheet-title"
                        className="text-foreground truncate text-lg font-semibold tracking-[-0.01em]"
                      >
                        {title}
                      </DialogPrimitive.Title>
                      {subtitle ? (
                        // Two lines on a phone, where one line of a 361px
                        // header cut the sentence mid-word; one from `md`.
                        <DialogPrimitive.Description className="text-muted-foreground line-clamp-2 text-sm text-pretty md:line-clamp-1">
                          {subtitle}
                        </DialogPrimitive.Description>
                      ) : (
                        // Radix warns when a described dialog has no description node;
                        // an explicitly absent one keeps the a11y tree quiet.
                        <DialogPrimitive.Description className="sr-only">
                          {title}
                        </DialogPrimitive.Description>
                      )}
                    </div>
                    <div className="flex shrink-0 items-center gap-2">
                      {headerActions}
                      <PageSheetClose label={closeLabel} />
                    </div>
                  </header>
                )}
                <div className={cn('min-h-0 flex-1', bodyClassName)}>{children}</div>
              </motion.div>
            </DialogPrimitive.Content>
          </DialogPrimitive.Portal>
        )}
      </AnimatePresence>
    </DialogPrimitive.Root>
  )
}

/**
 * The grabber band: the sheet's universal handle, on every viewport.
 *
 * The pill is the affordance ("this pulls down") and a real close button: a
 * tap on it closes, the keyboard reaches it, and on a coarse pointer it is a
 * 44px target. The band around it is the drag hot zone, and a press on the pill
 * may become a pull too (`startDrag` lets it): it is the single most natural
 * place to start one. A pull that falls short ends with a click on the pill
 * that rode along under the finger, so the click is swallowed when the press
 * became a pull. `touch-none` keeps the browser from turning the pull into a
 * page scroll or pull-to-refresh.
 */
function PageSheetGrabber({
  label,
  onPointerDown,
  pulledRef,
}: {
  label: string
  onPointerDown: (event: React.PointerEvent) => void
  pulledRef: React.RefObject<boolean>
}): JSX.Element {
  return (
    <div
      data-slot="page-sheet-grabber"
      className="flex shrink-0 cursor-grab touch-none justify-center py-2 select-none active:cursor-grabbing pointer-coarse:py-0"
      onPointerDown={onPointerDown}
    >
      <DialogPrimitive.Close
        data-slot="page-sheet-grabber-close"
        onClick={(event) => {
          if (pulledRef.current) event.preventDefault()
        }}
        className={cn(
          'flex h-4 w-14 cursor-grab items-center justify-center rounded-full outline-none active:cursor-grabbing pointer-coarse:h-11 pointer-coarse:w-24',
          FOCUS_RING
        )}
      >
        <span className="bg-muted-foreground/25 h-1 w-9 rounded-full" aria-hidden />
        <span className="sr-only">{label}</span>
      </DialogPrimitive.Close>
    </div>
  )
}

/**
 * The sheet's close control, composable anywhere inside its content.
 *
 * Rides Radix's Dialog context, so a headerless sheet can hand this to the row
 * its content already owns (the Archiv workspace's identity row) instead of
 * floating a second control over it.
 *
 * Visible on every viewport. It was hidden below `md` on the theory that the
 * grabber was the phone's close, and an X beside it two controls asking one
 * question; in practice the pull is a gesture nobody is told about, and a
 * reader on a phone who did not know it had no visible way out. The X is the
 * way out everyone recognises; the pull is the shortcut. Grown, not given a
 * catchment, on a coarse pointer: header actions stand right beside it.
 */
export function PageSheetClose({ label }: { label: string }): JSX.Element {
  return (
    <DialogPrimitive.Close
      data-slot="page-sheet-close"
      className={cn(
        'text-muted-foreground hover:bg-accent hover:text-foreground flex size-9 shrink-0 items-center justify-center rounded-lg outline-none transition-colors duration-quick ease-out motion-reduce:transition-none pointer-coarse:size-11',
        FOCUS_RING,
      )}
    >
      <X className="size-4" aria-hidden />
      <span className="sr-only">{label}</span>
    </DialogPrimitive.Close>
  )
}
