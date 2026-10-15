'use client'

import * as React from 'react'
import * as TooltipPrimitive from '@radix-ui/react-tooltip'

import { cn } from '@/lib/utils'
import { OVERLAY_EXIT, OVERLAY_REDUCED } from '@/components/ui/overlay-motion'

function TooltipProvider({
  delayDuration = 0,
  ...props
}: React.ComponentPropsWithoutRef<typeof TooltipPrimitive.Provider>) {
  return <TooltipPrimitive.Provider data-slot="tooltip-provider" delayDuration={delayDuration} {...props} />
}

/**
 * A label for a pointer: what an icon-only control is called, a shortcut, the
 * full text of a truncated name. On a touch screen it never opens (Radix ignores
 * touch pointers on purpose: a tap on a control is a press, not a question), so
 * it may carry nothing a finger needs. Information the reader needs on a phone
 * lives in visible text, or in a {@link Toggletip}.
 */
const Tooltip = ({ ...props }: React.ComponentPropsWithoutRef<typeof TooltipPrimitive.Root>) => (
  <TooltipProvider>
    <TooltipPrimitive.Root data-slot="tooltip" {...props} />
  </TooltipProvider>
)

interface ToggletipControl {
  open: boolean
  setOpen: (open: boolean) => void
  /** Whether it was open when the current press began (Radix closes it on press). */
  openAtPress: React.MutableRefObject<boolean>
}

const ToggletipContext = React.createContext<ToggletipControl | null>(null)

/**
 * A tooltip a finger can open: the same bubble, but a tap on its trigger
 * toggles it, and a tap anywhere else (or Escape) closes it. With a mouse it
 * behaves as a {@link Tooltip}: hover shows it, a click closes it.
 *
 * For a trigger that exists only to explain: an info glyph beside a term, a
 * chart column whose value is the answer, the reason a control is unavailable.
 * Never for a control that DOES something; there the tap must stay the action,
 * and what the tooltip said belongs in the control's visible label. Compose it
 * with the same parts: `<Toggletip><TooltipTrigger/><TooltipContent/></Toggletip>`.
 *
 * Why not open Radix's tooltip on focus, which a tap gives on most browsers:
 * iOS Safari does not focus a button on tap at all, and the focus guard in
 * `TooltipTrigger` refuses pointer focus on purpose (a popover handing focus to
 * its first control must not pop a tooltip). A tap is the one signal every
 * touch browser sends, so the tap is what this listens to.
 */
function Toggletip({
  defaultOpen = false,
  children,
  ...props
}: Omit<React.ComponentPropsWithoutRef<typeof TooltipPrimitive.Root>, 'open' | 'onOpenChange'>) {
  const [open, setOpen] = React.useState(defaultOpen)
  const openAtPress = React.useRef(false)
  const control = React.useMemo<ToggletipControl>(() => ({ open, setOpen, openAtPress }), [open])
  return (
    <TooltipProvider>
      <TooltipPrimitive.Root data-slot="toggletip" open={open} onOpenChange={setOpen} {...props}>
        <ToggletipContext.Provider value={control}>{children}</ToggletipContext.Provider>
      </TooltipPrimitive.Root>
    </TooltipProvider>
  )
}

/**
 * Opens on hover, and on focus only when the focus is one a keyboard user can
 * see (`:focus-visible`).
 *
 * Radix opens a tooltip on every focus event. A popover or dialog moves focus
 * to its first focusable element when it opens and back to its trigger when it
 * closes, so a help icon placed first in a popover showed its tooltip the
 * moment a click opened the popover. The browser already tells the two apart:
 * focus that follows a pointer click does not match `:focus-visible`, focus
 * reached with Tab does. Cancelling the event is how Radix's composed handler
 * is told to skip opening; focus itself is not cancelable, so nothing else
 * changes.
 */
const TooltipTrigger = React.forwardRef<
  React.ElementRef<typeof TooltipPrimitive.Trigger>,
  React.ComponentPropsWithoutRef<typeof TooltipPrimitive.Trigger>
>(({ onFocus, onPointerDown, onClick, ...props }, ref) => {
  const toggletip = React.useContext(ToggletipContext)
  // Which pointer pressed, read at the press because the click that follows
  // carries no pointer type in every engine.
  const pressedBy = React.useRef<string | null>(null)
  return (
    <TooltipPrimitive.Trigger
      ref={ref}
      data-slot="tooltip-trigger"
      onFocus={(event) => {
        onFocus?.(event)
        if (!isFocusVisible(event.currentTarget)) event.preventDefault()
      }}
      onPointerDown={(event) => {
        onPointerDown?.(event)
        pressedBy.current = event.pointerType
        if (toggletip) toggletip.openAtPress.current = toggletip.open
      }}
      onClick={(event) => {
        onClick?.(event)
        const pointer = pressedBy.current
        pressedBy.current = null
        if (!toggletip || pointer === 'mouse') return
        // Radix closes a tooltip on every trigger click; a toggletip's tap is
        // the toggle, so that close is cancelled and the toggle applied instead.
        // A tap is keyed on the state at the PRESS: Radix also closes on
        // pointerdown, so by the click an open toggletip already reads as
        // closed. Enter or Space (no press at all) toggles what is showing.
        event.preventDefault()
        const wasOpen = pointer === null ? toggletip.open : toggletip.openAtPress.current
        toggletip.setOpen(!wasOpen)
      }}
      {...props}
    />
  )
})
TooltipTrigger.displayName = TooltipPrimitive.Trigger.displayName

function isFocusVisible(element: Element): boolean {
  try {
    return element.matches(':focus-visible')
  } catch {
    // An engine without the selector keeps Radix's open-on-focus.
    return true
  }
}

const TooltipContent = React.forwardRef<
  React.ElementRef<typeof TooltipPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof TooltipPrimitive.Content>
>(({ className, sideOffset = 4, children, ...props }, ref) => (
  <TooltipPrimitive.Portal>
    <TooltipPrimitive.Content
      ref={ref}
      data-slot="tooltip-content"
      sideOffset={sideOffset}
      className={cn(
        'bg-foreground text-background animate-in fade-in-0 zoom-in-95 data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95 data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2 z-50 w-fit max-w-(--radix-tooltip-content-available-width) origin-(--radix-tooltip-content-transform-origin) rounded-md px-3 py-1.5 text-xs font-medium text-balance shadow-xs '
        + `duration-base ease-entrance ${OVERLAY_EXIT} ${OVERLAY_REDUCED}`,
        className
      )}
      {...props}
    >
      {children}
      <TooltipPrimitive.Arrow className="bg-foreground fill-foreground z-50 size-2.5 translate-y-[calc(-50%_-_2px)] rotate-45" />
    </TooltipPrimitive.Content>
  </TooltipPrimitive.Portal>
))
TooltipContent.displayName = TooltipPrimitive.Content.displayName

export { Toggletip, Tooltip, TooltipTrigger, TooltipContent, TooltipProvider }
