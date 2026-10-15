'use client'

import * as React from 'react'
import * as DialogPrimitive from '@radix-ui/react-dialog'
import { XIcon } from 'lucide-react'

import { twMerge } from 'tailwind-merge'

import { cn } from '@/lib/utils'
import { useSheetPull } from '@/components/ui/sheet-pull'
import { FOCUS_RING } from '@/components/ui/focus-ring'
import { OVERLAY_MOTION } from '@/components/ui/overlay-motion'

const Dialog = DialogPrimitive.Root

const DialogTrigger = DialogPrimitive.Trigger

const DialogPortal = DialogPrimitive.Portal

const DialogClose = DialogPrimitive.Close

const DialogOverlay = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Overlay>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Overlay>
>(({ className, ...props }, ref) => (
  <DialogPrimitive.Overlay
    ref={ref}
    data-slot="dialog-overlay"
    className={cn(
      'data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 bg-overlay fixed inset-0 z-50 backdrop-blur-sm ' +
        OVERLAY_MOTION,
      className
    )}
    {...props}
  />
))
DialogOverlay.displayName = DialogPrimitive.Overlay.displayName

/**
 * How a dialog presents itself on a phone: below `sm`, or a phone on its side
 * (the `phone:` variant, `globals.css`). From `sm` up on anything else it is
 * the centred card, whatever this says.
 *
 * - `sheet` (the default): anchored to the bottom edge, rounded on top, capped
 *   in `dvh` under the status bar, scrolling inside, its footer pinned at the
 *   bottom with the buttons stacked full width and the primary one (last in the
 *   DOM, as on the desktop's right) nearest the thumb. A grabber says it pulls
 *   down, and it does. A floating card on a phone is mostly margin, its
 *   actions sit in the middle of the screen, and its close is the furthest
 *   point from the hand holding it.
 * - `fullscreen`: the whole screen, for an editor with several sections, where
 *   even a tall sheet leaves a sliver of page the thumb keeps landing on.
 * - `none`: the caller lays the dialog out on a phone itself (the command
 *   palette, a viewer that sizes itself).
 */
export type DialogMobilePresentation = 'sheet' | 'fullscreen' | 'none'

/**
 * The caller's utilities that reach a phone: unprefixed, or prefixed `max-sm:`
 * or `phone:` (the variants whose screens the presentation styles). A desktop
 * override like `sm:max-w-2xl` says nothing about the phone.
 */
function phoneReach(className: string | undefined): string {
  return (className ?? '')
    .split(/\s+/)
    .flatMap((token) => {
      const match = /^(?:(?:max-sm|phone):)?([^:]+)$/.exec(token)
      return match ? [match[1]] : []
    })
    .join(' ')
}

/** Whether `reach` sets the property `probe` sets (tailwind-merge's notion of a conflict). */
const callerSets = (probe: string, reach: string): boolean => !twMerge(probe, reach).split(' ').includes(probe)

/**
 * `[class, probe]` pairs, kept unless the caller already sets the probe's
 * property where a phone sees it.
 *
 * WHY THE CALLER WINS. On a desktop the caller already overrides the base
 * classes by naming the same utility (tailwind-merge drops the base's). A
 * `phone:` class is a different utility to tailwind-merge, so without this the
 * presentation would quietly beat a caller's explicit `p-0` or `rounded-none`
 * on exactly the screens nobody reviews on. A dialog that lays out its own
 * padding owns its safe area too, and says so in its own class list.
 */
function unlessCallerSets(rules: ReadonlyArray<readonly [string, string]>, reach: string): string {
  return rules
    .filter(([, probe]) => !callerSets(probe, reach))
    .map(([cls]) => cls)
    .join(' ')
}

/**
 * The properties that make a dialog's position on screen. A caller that sets
 * any of them (a viewer at `h-[90dvh]`, the review at `inset-0`, a palette at
 * `top-[30%]`) has laid itself out, and gets no sheet: half a bottom sheet
 * grafted onto someone else's geometry is neither.
 */
const GEOMETRY_PROBES = ['top-0', 'bottom-0', 'translate-y-0', 'h-0'] as const

/**
 * Sheet arrival: up from the bottom edge on `--motion-deliberate` /
 * `--ease-entrance`, leaving one step shorter on `--ease-exit`. A tween, not a
 * spring: the travel is the sheet's own height, and any overshoot percentage is
 * out of the pixel budget at that distance (design language, Motion). No scale
 * and no fade on the panel; the scrim fades. `motion-reduce:animate-none` in
 * `OVERLAY_MOTION` removes the keyframes outright.
 */
const PHONE_SHEET_MOTION =
  'phone:data-[state=open]:slide-in-from-bottom phone:data-[state=open]:zoom-in-100 phone:data-[state=open]:fade-in-100 phone:data-[state=open]:duration-deliberate phone:data-[state=closed]:slide-out-to-bottom phone:data-[state=closed]:zoom-out-100 phone:data-[state=closed]:fade-out-100 phone:data-[state=closed]:duration-base'

const SHEET_GEOMETRY =
  'phone:top-auto phone:bottom-0 phone:translate-y-0 phone:max-h-[calc(100dvh-max(1.5rem,env(safe-area-inset-top)+0.75rem))] max-sm:max-w-none'

const SHEET_CHROME: ReadonlyArray<readonly [string, string]> = [
  ['phone:rounded-t-2xl phone:rounded-b-none', 'rounded-t-none'],
  ['phone:border-b-0', 'border-b-0'],
  ['max-sm:border-x-0', 'border-x-0'],
]

const FULLSCREEN_GEOMETRY =
  'phone:inset-0 phone:h-dvh phone:max-h-dvh phone:max-w-none phone:translate-x-0 phone:translate-y-0 phone:content-start'

const FULLSCREEN_CHROME: ReadonlyArray<readonly [string, string]> = [
  ['phone:rounded-none', 'rounded-none'],
  ['phone:border-0', 'border-0'],
  ['phone:pt-[max(1.5rem,env(safe-area-inset-top))]', 'pt-0'],
  ['phone:pl-[max(1rem,env(safe-area-inset-left))]', 'pl-0'],
  ['phone:pr-[max(1rem,env(safe-area-inset-right))]', 'pr-0'],
]

/**
 * The bottom edge, for both presentations: clear the home indicator, and pin
 * the footer there.
 *
 * The dialog's padding stays what it is (callers lay full-bleed rows against
 * `p-6`, and a padding that changed under them on a phone broke them). The
 * pinned footer instead reaches DOWN through the bottom padding: a negative
 * margin of exactly that padding, and the same amount back as its own padding,
 * so its paper runs to the screen edge, the content scrolls behind it rather
 * than showing through a gap below it, and its buttons stand clear of the home
 * indicator. Its sticky inset is the same negative amount, because a sticky
 * box sticks to the scroll container's CONTENT edge (the padding is
 * subtracted), and at `bottom-0` it rode up over the last line of the body by
 * exactly the padding. The footer rules are `:where()`-wrapped: zero specificity, so a
 * footer that positions or pads itself still wins with its own classes.
 */
const PINNED_FOOTER =
  'phone:pb-[max(1.5rem,env(safe-area-inset-bottom))] ' +
  'phone:[:where(&_[data-slot=dialog-footer])]:sticky phone:[:where(&_[data-slot=dialog-footer])]:-bottom-[max(1.5rem,env(safe-area-inset-bottom))] ' +
  'phone:[:where(&_[data-slot=dialog-footer])]:z-[1] phone:[:where(&_[data-slot=dialog-footer])]:bg-popover ' +
  'phone:[:where(&_[data-slot=dialog-footer])]:pt-3 ' +
  'phone:[:where(&_[data-slot=dialog-footer])]:-mb-[max(1.5rem,env(safe-area-inset-bottom))] ' +
  'phone:[:where(&_[data-slot=dialog-footer])]:pb-[max(1.5rem,env(safe-area-inset-bottom))]'

/** A finger drives the pointer: no hover, and a focused field raises a keyboard. */
function isCoarsePointer(): boolean {
  return typeof window.matchMedia === 'function' && window.matchMedia('(pointer: coarse)').matches
}

/** Resolve the presentation against the caller's own class list. */
function phonePresentation(
  requested: DialogMobilePresentation,
  className: string | undefined
): { presentation: DialogMobilePresentation; classes: string } {
  const reach = phoneReach(className)
  const presentation =
    requested === 'sheet' && GEOMETRY_PROBES.some((probe) => callerSets(probe, phoneReach(className)))
      ? 'none'
      : requested
  if (presentation === 'none') return { presentation, classes: '' }
  const pinned = callerSets('pb-0', reach) ? '' : PINNED_FOOTER
  const classes =
    presentation === 'sheet'
      ? [SHEET_GEOMETRY, unlessCallerSets(SHEET_CHROME, reach), pinned, PHONE_SHEET_MOTION]
      : [FULLSCREEN_GEOMETRY, unlessCallerSets(FULLSCREEN_CHROME, reach), pinned, PHONE_SHEET_MOTION]
  return { presentation, classes: classes.join(' ') }
}

const DialogContent = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Content> & {
    showCloseButton?: boolean
    /** How the dialog lays itself out on a phone. Defaults to a bottom sheet. */
    mobilePresentation?: DialogMobilePresentation
    /** Shorthand for `mobilePresentation="fullscreen"`. */
    fullScreenOnMobile?: boolean
    /** The close button's accessible name, in the reader's language. */
    closeLabel?: string
  }
>(
  (
    {
      className,
      children,
      showCloseButton = true,
      mobilePresentation,
      fullScreenOnMobile = false,
      closeLabel = 'Close',
      onOpenAutoFocus,
      ...props
    },
    ref
  ) => {
    const closeRef = React.useRef<HTMLButtonElement>(null)
    const dismiss = React.useCallback(() => closeRef.current?.click(), [])
    const pull = useSheetPull(dismiss)
    const { presentation, classes: phoneClasses } = phonePresentation(
      mobilePresentation ?? (fullScreenOnMobile ? 'fullscreen' : 'sheet'),
      className
    )
    // The grabber promises a pull, so it appears only where one works: a sheet
    // the reader may close (a dialog that hides its X has a reason to).
    const grabber = presentation === 'sheet' && showCloseButton

    return (
      <DialogPortal data-slot="dialog-portal">
        <DialogOverlay />
        <DialogPrimitive.Content
          ref={ref}
          data-slot="dialog-content"
          data-mobile-presentation={presentation}
          // `grid-cols-1` is `minmax(0, 1fr)`. Without it the content grid's
          // implicit `auto` column cannot shrink below its widest `truncate` line,
          // so one long file name pushed the whole dialog past its own edge and cut
          // every other line off on the right (the mail import's history did).
          onOpenAutoFocus={(event) => {
            onOpenAutoFocus?.(event)
            if (event.defaultPrevented || !isCoarsePointer()) return
            // Under a finger, the dialog itself takes focus on open, not its
            // first field: focusing a field raises the keyboard, which covers
            // the bottom sheet it belongs to (its question, its footer) before
            // the reader has read either. They tap the field when they are
            // ready. A mouse or keyboard user still lands in the first field.
            event.preventDefault()
            ;(event.currentTarget as HTMLElement | null)?.focus()
          }}
          className={cn(
            'bg-popover text-popover-foreground data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95 fixed left-[50%] top-[50%] z-50 grid max-h-[calc(100dvh-2rem)] w-full max-w-[calc(100%-2rem)] translate-x-[-50%] translate-y-[-50%] grid-cols-1 gap-4 overflow-y-auto overscroll-contain rounded-xl border p-6 shadow-lg sm:max-w-lg ' +
              OVERLAY_MOTION,
            phoneClasses,
            className
          )}
          {...props}
        >
          {grabber && (
            <div
              data-slot="dialog-grabber"
              aria-hidden
              // The band left of the close button: where a thumb reaches for
              // the top edge. `touch-none` so the browser does not claim the
              // pull as a scroll of the sheet's own content.
              className="phone:flex absolute inset-x-14 top-0 z-[1] hidden h-6 cursor-grab touch-none select-none justify-center pt-2 active:cursor-grabbing"
              {...pull}
            >
              <span className="bg-muted-foreground/25 h-1 w-9 rounded-full" />
            </div>
          )}
          {children}
          {showCloseButton && (
            <DialogPrimitive.Close
              ref={closeRef}
              data-slot="dialog-close"
              className={cn(
                'text-muted-foreground duration-quick hover:bg-accent hover:text-foreground pointer-coarse:size-11 pointer-coarse:top-2.5 pointer-coarse:right-2.5 absolute right-4 top-4 z-[2] inline-flex size-8 items-center justify-center rounded-md outline-none transition-colors ease-out disabled:pointer-events-none disabled:opacity-50',
                // Below the status bar and clear of the Dynamic Island's side,
                // where the full screen puts the top edge under them.
                presentation === 'fullscreen' &&
                  'phone:top-[calc(env(safe-area-inset-top)+0.625rem)] phone:right-[calc(env(safe-area-inset-right)+0.625rem)]',
                FOCUS_RING
              )}
            >
              <XIcon className="size-4" />
              <span className="sr-only">{closeLabel}</span>
            </DialogPrimitive.Close>
          )}
        </DialogPrimitive.Content>
      </DialogPortal>
    )
  }
)
DialogContent.displayName = DialogPrimitive.Content.displayName

function DialogHeader({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      data-slot="dialog-header"
      className={cn('flex flex-col gap-1.5 text-center sm:text-left', className)}
      {...props}
    />
  )
}

function DialogFooter({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      data-slot="dialog-footer"
      // Stacked on a phone in DOM order, so the primary action (last, as it is
      // rightmost on a desktop) lands at the bottom: nearest the thumb, and on a
      // sheet pinned to the bottom edge (`DialogContent`'s phone presentation).
      // A flex column stretches each button to the full width.
      className={cn('flex flex-col gap-2 sm:flex-row sm:justify-end', className)}
      {...props}
    />
  )
}

const DialogTitle = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Title>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Title>
>(({ className, ...props }, ref) => (
  <DialogPrimitive.Title
    ref={ref}
    data-slot="dialog-title"
    className={cn('text-lg font-semibold leading-none', className)}
    {...props}
  />
))
DialogTitle.displayName = DialogPrimitive.Title.displayName

const DialogDescription = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Description>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Description>
>(({ className, ...props }, ref) => (
  <DialogPrimitive.Description
    ref={ref}
    data-slot="dialog-description"
    className={cn('text-muted-foreground text-sm', className)}
    {...props}
  />
))
DialogDescription.displayName = DialogPrimitive.Description.displayName

export {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogOverlay,
  DialogPortal,
  DialogTitle,
  DialogTrigger,
}
