'use client'

/**
 * shadcn/ui `command` primitive built on cmdk — a keyboard-navigable,
 * fuzzy-filtered command list. `CommandDialog` wraps it in the project's
 * Dialog so it can be summoned as a palette (⌘K), with no open or close motion.
 */

import * as React from 'react'
import { Command as CommandPrimitive } from 'cmdk'
import { SearchIcon } from 'lucide-react'

import { cn } from '@/lib/utils'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from '@/components/ui/dialog'
import { Kbd, KbdGroup } from '@/components/ui/kbd'

const Command = React.forwardRef<
  React.ElementRef<typeof CommandPrimitive>,
  React.ComponentPropsWithoutRef<typeof CommandPrimitive>
>(({ className, ...props }, ref) => (
  <CommandPrimitive
    ref={ref}
    data-slot="command"
    className={cn(
      'bg-popover text-popover-foreground flex h-full w-full flex-col overflow-hidden rounded-overlay',
      className
    )}
    {...props}
  />
))
Command.displayName = CommandPrimitive.displayName

export interface CommandHintLabels {
  move: string
  open: string
  close: string
}

interface CommandDialogProps extends React.ComponentPropsWithoutRef<typeof Dialog> {
  /** Accessible dialog title (visually hidden). */
  title: string
  /** Accessible dialog description (visually hidden). */
  description: string
  className?: string
  /** When true, render ↑ ↓ ↵ Esc keycaps under the list. Off by default. */
  showHints?: boolean
  /** Visible labels next to the hint keys. Ignored unless `showHints` is set. */
  hintLabels?: CommandHintLabels
  /** A further key at the footer's end, for what this list alone offers (the palette's „alle Treffer“). */
  hintsTrailing?: React.ReactNode
  /**
   * Open and close with no motion (`DialogContent`'s `instant`). On by default:
   * a palette is summoned from the keyboard many times a day, and Raycast's
   * answer (no open or close animation at all) is the right one for it.
   */
  instant?: boolean
  /**
   * The cmdk root's own controls: a `filter` that ranks rows the typed words
   * do not spell (live search hits), and a controlled `value` for the row the
   * arrows are on.
   */
  commandProps?: Pick<React.ComponentPropsWithoutRef<typeof CommandPrimitive>, 'filter' | 'value' | 'onValueChange' | 'loop'>
}

/**
 * The keys of a list you walk with the keyboard, each with its word: the
 * palette's footer, and the footer of every picker that walks the same way
 * (the composer's `#`), so one key never has two descriptions.
 */
function CommandHints({ labels, className, trailing }: { labels?: CommandHintLabels; className?: string; trailing?: React.ReactNode }) {
  return (
    <div
      data-slot="command-hints"
      className={cn('text-muted-foreground flex shrink-0 items-center gap-3 border-t bg-muted/40 px-3 py-2 text-xs', className)}
    >
      <span className="inline-flex items-center gap-1.5">
        <KbdGroup>
          <Kbd>↑</Kbd>
          <Kbd>↓</Kbd>
        </KbdGroup>
        {labels?.move}
      </span>
      <span className="inline-flex items-center gap-1.5">
        <Kbd>↵</Kbd>
        {labels?.open}
      </span>
      <span className="inline-flex items-center gap-1.5">
        <Kbd>Esc</Kbd>
        {labels?.close}
      </span>
      {trailing ? <span className="ml-auto inline-flex items-center gap-1.5">{trailing}</span> : null}
    </div>
  )
}

function CommandDialog({
  title,
  description,
  children,
  className,
  showHints = false,
  hintLabels,
  hintsTrailing,
  instant = true,
  commandProps,
  ...props
}: CommandDialogProps) {
  return (
    <Dialog {...props}>
      <DialogContent
        showCloseButton={false}
        instant={instant}
        className={cn('top-[30%] translate-y-0 gap-0 overflow-hidden rounded-overlay p-0', className)}
      >
        <DialogTitle className="sr-only">{title}</DialogTitle>
        <DialogDescription className="sr-only">{description}</DialogDescription>
        <Command {...commandProps} className="[&_[cmdk-group-heading]]:text-muted-foreground [&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:py-1.5 [&_[cmdk-group-heading]]:text-xs [&_[cmdk-group-heading]]:font-medium [&_[cmdk-input-wrapper]_svg]:size-4 [&_[cmdk-item]]:px-2 [&_[cmdk-item]]:py-2 [&_[cmdk-item]_svg]:size-4">
          {children}
        </Command>
        {showHints ? <CommandHints labels={hintLabels} trailing={hintsTrailing} /> : null}
      </DialogContent>
    </Dialog>
  )
}

const CommandInput = React.forwardRef<
  React.ElementRef<typeof CommandPrimitive.Input>,
  React.ComponentPropsWithoutRef<typeof CommandPrimitive.Input> & {
    /**
     * Something is being fetched for what is typed: a thin sweep runs along
     * the field's bottom edge, where the eye already is, instead of a spinner
     * and a word appearing and vanishing somewhere in the list. The caller
     * delays it, so a fast answer never shows it.
     */
    busy?: boolean
  }
>(({ className, busy = false, ...props }, ref) => (
  <div
    data-slot="command-input-wrapper"
    cmdk-input-wrapper=""
    className="relative flex h-11 items-center gap-2 border-b border-border px-3 transition-colors duration-snap ease-out has-[:focus-visible]:bg-muted/40 motion-reduce:transition-none"
  >
    <span
      aria-hidden
      data-slot="command-input-progress"
      data-busy={busy || undefined}
      className={cn(
        'pointer-events-none absolute inset-x-0 -bottom-px h-0.5 overflow-hidden transition-opacity duration-quick motion-reduce:transition-none',
        busy ? 'opacity-100' : 'opacity-0'
      )}
    >
      {/* Mounted at rest too, paused, so the track's fade carries the sweep out instead of cutting it. */}
      <span className={cn('animate-progress-sweep block h-full w-1/3 rounded-full bg-primary/60 motion-reduce:animate-none', !busy && '[animation-play-state:paused]')} />
    </span>
    <SearchIcon className="size-4 shrink-0 text-muted-foreground" aria-hidden />
    <CommandPrimitive.Input
      ref={ref}
      data-slot="command-input"
      className={cn(
        // Ring-less: a focus ring on this field sits on the wrapper's
        // border-b and reads as a broken top edge. The wrapper wash is
        // the focus signal instead.
        'placeholder:text-muted-foreground flex h-10 w-full bg-transparent py-3 text-sm outline-none ring-0 focus-visible:ring-0 disabled:cursor-not-allowed disabled:opacity-50',
        className
      )}
      {...props}
    />
  </div>
))
CommandInput.displayName = CommandPrimitive.Input.displayName

const CommandList = React.forwardRef<
  React.ElementRef<typeof CommandPrimitive.List>,
  React.ComponentPropsWithoutRef<typeof CommandPrimitive.List>
>(({ className, ...props }, ref) => (
  <CommandPrimitive.List
    ref={ref}
    data-slot="command-list"
    className={cn('max-h-80 overflow-x-hidden overflow-y-auto p-1', className)}
    {...props}
  />
))
CommandList.displayName = CommandPrimitive.List.displayName

const CommandEmpty = React.forwardRef<
  React.ElementRef<typeof CommandPrimitive.Empty>,
  React.ComponentPropsWithoutRef<typeof CommandPrimitive.Empty>
>(({ className, ...props }, ref) => (
  <CommandPrimitive.Empty
    ref={ref}
    data-slot="command-empty"
    className={cn('py-6 text-center text-sm text-muted-foreground', className)}
    {...props}
  />
))
CommandEmpty.displayName = CommandPrimitive.Empty.displayName

const CommandGroup = React.forwardRef<
  React.ElementRef<typeof CommandPrimitive.Group>,
  React.ComponentPropsWithoutRef<typeof CommandPrimitive.Group>
>(({ className, ...props }, ref) => (
  <CommandPrimitive.Group
    ref={ref}
    data-slot="command-group"
    className={cn('text-foreground overflow-hidden p-1', className)}
    {...props}
  />
))
CommandGroup.displayName = CommandPrimitive.Group.displayName

const CommandSeparator = React.forwardRef<
  React.ElementRef<typeof CommandPrimitive.Separator>,
  React.ComponentPropsWithoutRef<typeof CommandPrimitive.Separator>
>(({ className, ...props }, ref) => (
  <CommandPrimitive.Separator
    ref={ref}
    data-slot="command-separator"
    className={cn('bg-border -mx-1 h-px', className)}
    {...props}
  />
))
CommandSeparator.displayName = CommandPrimitive.Separator.displayName

const CommandItem = React.forwardRef<
  React.ElementRef<typeof CommandPrimitive.Item>,
  React.ComponentPropsWithoutRef<typeof CommandPrimitive.Item>
>(({ className, ...props }, ref) => (
  <CommandPrimitive.Item
    ref={ref}
    data-slot="command-item"
    className={cn(
      'data-[selected=true]:bg-accent data-[selected=true]:text-accent-foreground relative flex cursor-default items-center gap-2 rounded-control px-2 py-1.5 text-sm outline-none select-none data-[disabled=true]:pointer-events-none data-[disabled=true]:opacity-50 [&_svg]:pointer-events-none [&_svg]:shrink-0',
      className
    )}
    {...props}
  />
))
CommandItem.displayName = CommandPrimitive.Item.displayName

function CommandShortcut({ className, ...props }: React.ComponentProps<'span'>) {
  return (
    <span
      data-slot="command-shortcut"
      className={cn(
        'text-muted-foreground ml-auto inline-flex items-center gap-1 text-xs tracking-widest',
        className,
      )}
      {...props}
    />
  )
}

export {
  Command,
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandHints,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
  CommandShortcut,
}
