'use client'

/**
 * One list of actions, two triggers.
 *
 * Dropdown (⋯) and context menu (right-click) are different Radix primitives
 * with the same parts. Surfaces build an entry list once; this renders it as
 * either shape so the two cannot drift. Nothing here knows what a document is.
 */

import type { ReactNode } from 'react'
import type { LucideIcon } from 'lucide-react'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuRadioGroup,
  ContextMenuRadioItem,
  ContextMenuSeparator,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
  ContextMenuTrigger,
} from '@/components/ui/context-menu'

export type ActionMenuItemEntry = {
  type: 'item'
  id: string
  label: string
  icon?: LucideIcon
  variant?: 'default' | 'destructive'
  disabled?: boolean
  /**
   * A second, quieter line under the label: why an item is disabled, or what
   * to do instead. Part of the item's accessible name, so a screen reader hears
   * the reason with the action it explains.
   */
  hint?: string
  /** Run on select. An entry with `href` may omit it: the link is the action. */
  onSelect?: () => void
  /**
   * Render the row as a real link (`<a>`): open in a new tab, or download. A
   * link keeps what a link is for — middle-click, copy address, the browser's
   * own download — where an `onSelect` calling `window.open` would lose it.
   */
  href?: string
  /** With `href`: download instead of navigating (the browser's own download). */
  download?: boolean
  testId?: string
}

export type ActionMenuSeparatorEntry = { type: 'separator' }

export type ActionMenuSubEntry = {
  type: 'sub'
  id: string
  label: string
  icon?: LucideIcon
  disabled?: boolean
  testId?: string
  items: ActionMenuEntry[]
}

export type ActionMenuRadioEntry = {
  type: 'radio-group'
  value: string
  onValueChange: (value: string) => void
  items: { value: string; label: string; testId?: string }[]
}

export type ActionMenuEntry =
  | ActionMenuItemEntry
  | ActionMenuSeparatorEntry
  | ActionMenuSubEntry
  | ActionMenuRadioEntry

type MenuParts = {
  Item: typeof DropdownMenuItem
  Separator: typeof DropdownMenuSeparator
  Sub: typeof DropdownMenuSub
  SubTrigger: typeof DropdownMenuSubTrigger
  SubContent: typeof DropdownMenuSubContent
  RadioGroup: typeof DropdownMenuRadioGroup
  RadioItem: typeof DropdownMenuRadioItem
  /**
   * A submenu's size: 16rem wide and at most 18rem tall, but never taller than
   * the room the menu has (on a phone on its side that is under 393px), so it
   * scrolls instead of running off the screen. Spelled per menu kind because
   * Radix names the variable after the primitive.
   */
  subContentClassName: string
}

const DROPDOWN_PARTS: MenuParts = {
  Item: DropdownMenuItem,
  Separator: DropdownMenuSeparator,
  Sub: DropdownMenuSub,
  SubTrigger: DropdownMenuSubTrigger,
  SubContent: DropdownMenuSubContent,
  RadioGroup: DropdownMenuRadioGroup,
  RadioItem: DropdownMenuRadioItem,
  subContentClassName: 'w-64 max-h-[min(18rem,var(--radix-dropdown-menu-content-available-height))]',
}

const CONTEXT_PARTS: MenuParts = {
  Item: ContextMenuItem,
  Separator: ContextMenuSeparator,
  Sub: ContextMenuSub,
  SubTrigger: ContextMenuSubTrigger,
  SubContent: ContextMenuSubContent,
  RadioGroup: ContextMenuRadioGroup,
  RadioItem: ContextMenuRadioItem,
  subContentClassName: 'w-64 max-h-[min(18rem,var(--radix-context-menu-content-available-height))]',
}

function renderEntries(entries: readonly ActionMenuEntry[], parts: MenuParts): ReactNode {
  return entries.map((entry, index) => {
    switch (entry.type) {
      case 'separator':
        return <parts.Separator key={`sep-${index}`} />
      case 'item': {
        const Icon = entry.icon
        const content = (
          <>
            {Icon ? <Icon className="size-4" aria-hidden /> : null}
            {entry.hint ? (
              <span className="flex min-w-0 flex-col">
                <span>{entry.label}</span>
                <span className="text-muted-foreground text-xs leading-snug">{entry.hint}</span>
              </span>
            ) : (
              entry.label
            )}
          </>
        )
        if (entry.href) {
          return (
            <parts.Item key={entry.id} variant={entry.variant} disabled={entry.disabled} onSelect={entry.onSelect} asChild>
              <a
                href={entry.href}
                data-testid={entry.testId}
                {...(entry.download ? { download: true } : { target: '_blank', rel: 'noreferrer' })}
              >
                {content}
              </a>
            </parts.Item>
          )
        }
        return (
          <parts.Item
            key={entry.id}
            variant={entry.variant}
            disabled={entry.disabled}
            onSelect={entry.onSelect}
            data-testid={entry.testId}
          >
            {content}
          </parts.Item>
        )
      }
      case 'sub': {
        const Icon = entry.icon
        return (
          <parts.Sub key={entry.id}>
            <parts.SubTrigger disabled={entry.disabled} data-testid={entry.testId}>
              {Icon ? <Icon className="size-4" aria-hidden /> : null}
              {entry.label}
            </parts.SubTrigger>
            <parts.SubContent className={parts.subContentClassName}>
              {renderEntries(entry.items, parts)}
            </parts.SubContent>
          </parts.Sub>
        )
      }
      case 'radio-group':
        return (
          <parts.RadioGroup
            key={`radio-${index}`}
            value={entry.value}
            onValueChange={entry.onValueChange}
          >
            {entry.items.map((item) => (
              <parts.RadioItem key={item.value} value={item.value} data-testid={item.testId}>
                {item.label}
              </parts.RadioItem>
            ))}
          </parts.RadioGroup>
        )
      default: {
        const _exhaustive: never = entry
        return _exhaustive
      }
    }
  })
}

export interface ActionMenuProps {
  entries: readonly ActionMenuEntry[]
  mode: 'dropdown' | 'context'
  /** Dropdown trigger (the ⋯). Ignored in context mode. */
  trigger?: ReactNode
  /** Context-menu target. Ignored in dropdown mode. */
  children?: ReactNode
  contentClassName?: string
  align?: 'start' | 'end'
  side?: 'top' | 'right' | 'bottom' | 'left'
  onOpenChange?: (open: boolean) => void
  /**
   * Dropdown mode only: hold the open state outside, for a caller that opens
   * the menu itself (a row that mounts its menu on the press that asks for it).
   * Absent leaves it to the trigger.
   */
  open?: boolean
  /**
   * Context mode only: clone the child as the trigger (a `forwardRef` host
   * such as a table row). Default wraps in a div, which is the safe option
   * for a card that does not forward a ref.
   */
  asChild?: boolean
  /**
   * Context mode only: keep the context-menu host around the children while
   * `entries` is empty, for a caller that builds the entries in `onOpenChange`
   * (the first right-click on a row). Without it an empty list returns the
   * children bare, and the entries arriving later would wrap them in a new
   * host, which remounts the card or row under the pointer.
   */
  keepHost?: boolean
}

export function ActionMenu({
  entries,
  mode,
  trigger,
  children,
  contentClassName = 'w-56',
  align = 'end',
  side = 'bottom',
  onOpenChange,
  open,
  asChild = false,
  keepHost = false,
}: ActionMenuProps): ReactNode {
  if (entries.length === 0 && !(mode === 'context' && keepHost)) {
    // A context host with nothing to offer is still the listing; swallowing
    // it would blank the pane. A dropdown with nothing to offer is not a
    // control.
    return mode === 'context' ? (children ?? null) : null
  }

  if (mode === 'dropdown') {
    if (!trigger) return null
    return (
      <DropdownMenu open={open} onOpenChange={onOpenChange}>
        <DropdownMenuTrigger asChild>{trigger}</DropdownMenuTrigger>
        <DropdownMenuContent align={align} side={side} className={contentClassName}>
          {renderEntries(entries, DROPDOWN_PARTS)}
        </DropdownMenuContent>
      </DropdownMenu>
    )
  }

  return (
    <ContextMenu onOpenChange={onOpenChange}>
      <ContextMenuTrigger asChild>
        {asChild ? children : <div className="h-full min-w-0">{children}</div>}
      </ContextMenuTrigger>
      <ContextMenuContent className={contentClassName}>
        {renderEntries(entries, CONTEXT_PARTS)}
      </ContextMenuContent>
    </ContextMenu>
  )
}
