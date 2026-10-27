import * as React from 'react'
import { cva, type VariantProps } from 'class-variance-authority'

import { cn } from '@/lib/utils'

/**
 * CountPill — the small, soft rounded-full micro-badge that carries a count or
 * ratio ("5 Dokumente", "3/8 erfasst", "7" unread). It is a static,
 * non-interactive label; the shape lives here once so the surfaces that need it
 * cannot drift apart on padding.
 *
 * ## A number, or words
 *
 * - **`count`** — a plain number. The pill caps it at `max` (default 99) and
 *   shows `99+` above that, so a project with 12,345 elements cannot widen a
 *   filter segment or a nav row. The exact figure is never lost: it is the
 *   pill's `title` and the text a screen reader reads, while the visible `99+`
 *   is hidden from it. Pass `max={Number.POSITIVE_INFINITY}` only where the
 *   exact number IS the content and the row has room for it.
 * - **`children`** — words or a ratio the caller has already composed
 *   ("3/8 erfasst", "+4", a locale-formatted analytics figure). No cap: the pill
 *   cannot know what a string means.
 *
 * ## Which tone
 *
 * - **`muted` (default)** — a quiet numeric companion to a heading or a tab
 *   label. The number is context for something the reader is already looking at,
 *   so it must not compete with it. This is almost always the right answer.
 * - **`attention`** — the near-black action ink, for a count that is itself the
 *   signal: something is waiting for the reader and the pill is what tells them
 *   (the inbox "needs you" badge). Use it only where the number is a call to
 *   act, never merely because a count feels important. Ink rather than colour by
 *   design — the design language reserves chroma for provenance signals — and it
 *   keeps the pill legible on the collapsed rail's sunken surface.
 *
 * Distinct from {@link import('./chip').Chip}, which is the interactive,
 * variant-driven pill for clickable affordances (filters, tool tags, sources).
 * When you need hover/focus/click behaviour or a semantic colour, reach for
 * `Chip`; when you just need a number in a pill, reach for this.
 *
 * The project brief, the surfaced-document grid card and the inbox badge all
 * hand-rolled this identical span (and had already drifted on padding); it lives
 * here once.
 */
const countPillVariants = cva(
  'inline-flex min-w-5 shrink-0 items-center justify-center whitespace-nowrap rounded-full px-2 py-0.5 text-[11px] leading-none tabular-nums',
  {
    variants: {
      tone: {
        // Muted ink on the muted fill measured 4.44:1 at 11px (axe, 2026-10-27), under AA's 4.5:1:
        // the tabs' cure, ink at 70 % (`grid-design-language.md`, „Measured contrasts“).
        muted: 'bg-muted font-medium text-foreground/70',
        attention: 'bg-primary font-semibold text-primary-foreground',
      },
    },
    defaultVariants: {
      tone: 'muted',
    },
  }
)

/** Above this a `count` shows as `99+`. */
export const COUNT_PILL_MAX = 99

type CountPillBaseProps = Omit<React.HTMLAttributes<HTMLSpanElement>, 'children'> &
  VariantProps<typeof countPillVariants>

/** A number, capped at `max`. */
interface CountPillCountProps extends CountPillBaseProps {
  count: number
  /** The largest count shown as itself; anything above reads `{max}+`. */
  max?: number
  children?: never
}

/** Words or a ratio the caller composed; shown as given. */
interface CountPillTextProps extends CountPillBaseProps {
  count?: never
  max?: never
  children: React.ReactNode
}

export type CountPillProps = CountPillCountProps | CountPillTextProps

/** The integer a count stands for: a fraction or a negative is a caller's slip, not a count. */
const wholeCount = (value: number): number => (Number.isFinite(value) ? Math.max(0, Math.trunc(value)) : 0)

const CountPill = React.forwardRef<HTMLSpanElement, CountPillProps>(
  ({ className, tone, count, max = COUNT_PILL_MAX, children, title, ...props }, ref) => {
    const exact = count === undefined ? null : wholeCount(count)
    const capped = exact !== null && exact > max
    return (
      <span
        ref={ref}
        data-slot="count-pill"
        data-count={exact ?? undefined}
        title={capped ? (title ?? String(exact)) : title}
        className={cn(countPillVariants({ tone }), className)}
        {...props}
      >
        {exact === null ? (
          children
        ) : capped ? (
          <>
            {/* The visible cap is shorthand; a screen reader gets the figure. */}
            <span aria-hidden>{`${max}+`}</span>
            <span className="sr-only">{exact}</span>
          </>
        ) : (
          exact
        )}
      </span>
    )
  }
)
CountPill.displayName = 'CountPill'

export { CountPill, countPillVariants }
