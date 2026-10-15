'use client'

/**
 * A tool with its name written under it, for a finger.
 *
 * `ViewerIconButton` is right for a pointer and wrong for a thumb. Its label
 * is a tooltip and a `title`, and neither exists on a touch screen — so on a
 * phone the dock was nine unlabelled glyphs that a first-time user learns by
 * pressing. Here the name is on the control, at 11 px, the size of an iOS tab-bar caption, because a glove and a glare make a guessing game of a
 * glyph.
 *
 * One column of icon over caption, 56 px tall: a thumb's reach, and four of
 * them still fit a 393 px phone with room to spare. The caption is the
 * SHORT name; `label` is the full one and is what a screen reader hears, with
 * the caption inside it so voice control ("tap Schnitt") finds it.
 *
 * Built on the shared `Button`, for the same reason `ViewerIconButtonBase` is:
 * the focus ring, the press and the disabled treatment are the app's. Forwards
 * every prop so Radix can drive it as a popover trigger — the view menu is one.
 */

import { forwardRef, type ButtonHTMLAttributes, type ComponentType, type ReactNode } from 'react'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'

export interface ViewerToolButtonProps extends Omit<
  ButtonHTMLAttributes<HTMLButtonElement>,
  'onClick' | 'title' | 'children'
> {
  /** The full name, for assistive technology. Contains {@link caption}. */
  label: string
  /** What is written under the glyph. Defaults to {@link label}. */
  caption?: string
  icon: ComponentType<{ className?: string }>
  onClick?: () => void
  /** Present when this is a toggle; drives `aria-pressed` and the filled state. */
  active?: boolean
  disabled?: boolean
  /** A small marker on the glyph — "something here has changed". */
  marked?: boolean
  /** Rendered after the caption, e.g. the chevron of a control that opens a menu. */
  adornment?: ReactNode
  className?: string
}

export const ViewerToolButton = forwardRef<HTMLButtonElement, ViewerToolButtonProps>(
  function ViewerToolButton(
    {
      label,
      caption,
      icon: Icon,
      onClick,
      active,
      disabled,
      marked = false,
      adornment,
      className,
      ...rest
    },
    ref
  ) {
    return (
      <Button
        ref={ref}
        type="button"
        {...(active === undefined ? {} : { 'aria-pressed': active })}
        aria-label={label}
        disabled={disabled}
        onClick={onClick}
        variant={active ? 'default' : 'ghost'}
        data-slot="viewer-tool-button"
        className={cn(
          // `min-w-0 flex-1`: the tools share the bar's width equally. Six of
          // them on a 393px phone leave about 55px each, and the longest German
          // captions ("Einpassen", "Geschoße", "Grundriss") are 50 to 53px at
          // 11px: they fit with no side padding and ellipsize with any. Never
          // under 11px; a narrower phone shortens the caption, not the type.
          'pointer-coarse:h-14 pointer-coarse:min-w-0 h-14 min-w-0 flex-1 flex-col gap-0.5 rounded-xl px-0 py-1.5 text-[11px] leading-none',
          className
        )}
        {...rest}
      >
        <span className="relative">
          <Icon className="size-5" aria-hidden="true" />
          {marked && (
            <span
              aria-hidden="true"
              data-slot="viewer-tool-mark"
              className="bg-foreground ring-card absolute -right-1 -top-0.5 size-2 rounded-full ring-2"
            />
          )}
        </span>
        <span className="flex max-w-full items-center gap-0.5">
          <span className="truncate">{caption ?? label}</span>
          {adornment}
        </span>
      </Button>
    )
  }
)
