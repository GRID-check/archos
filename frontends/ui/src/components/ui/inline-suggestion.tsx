import type { HTMLAttributes, JSX, ReactNode } from 'react'
import { cn } from '@/lib/utils'
import { PilotiGlyph } from './piloti-glyph'

/**
 * InlineSuggestion — Piloti's quiet one-line suggestion inside a row it is
 * about (a file row, an upload row, a card's foot): its glyph, what it
 * suggests, why in one muted line, and the person's answer on the right. It is
 * a remark beside the thing, not a card over it: no border, no shadow, the
 * muted ground the row's own hover uses.
 *
 * The answer (`actions`) wraps under the text on a narrow row instead of
 * squeezing it, and its buttons wrap among themselves on a card. The caller
 * keeps clicks on it from reaching the row underneath (`stopRowEvents`).
 */
export function InlineSuggestion({
  title,
  detail,
  actions,
  className,
  stopRowEvents = true,
  ...props
}: {
  title: ReactNode
  /** One line of why; cut with an ellipsis, whole on hover through `title` of the caller's text. */
  detail?: ReactNode
  actions?: ReactNode
  /** Whether a click or a key inside it is kept from the row it sits in (a row that opens on click). */
  stopRowEvents?: boolean
} & Omit<HTMLAttributes<HTMLDivElement>, 'title'>): JSX.Element {
  const stop = stopRowEvents
    ? {
        onClick: (event: { stopPropagation: () => void }) => event.stopPropagation(),
        onKeyDown: (event: { stopPropagation: () => void }) => event.stopPropagation(),
        onPointerDown: (event: { stopPropagation: () => void }) => event.stopPropagation(),
      }
    : {}
  return (
    <div
      role="group"
      data-slot="inline-suggestion"
      className={cn('bg-muted/50 flex flex-wrap items-center gap-x-2 gap-y-1 rounded-md px-2 py-1.5 text-xs', className)}
      {...stop}
      {...props}
    >
      {/* The glyph stays beside the text; the text keeps at least 10rem before
          the answer wraps under it, so a narrow row (a phone, a card) never
          cuts the suggestion to one word. */}
      <div className="flex min-w-0 flex-1 basis-40 items-center gap-2">
        <PilotiGlyph size="xs" />
        <div className="min-w-0 flex-1">
          <p className="text-foreground truncate font-medium leading-snug">{title}</p>
          {detail && <p className="text-muted-foreground truncate leading-snug">{detail}</p>}
        </div>
      </div>
      {actions && <div className="ml-auto flex max-w-full flex-wrap items-center justify-end gap-1">{actions}</div>}
    </div>
  )
}
