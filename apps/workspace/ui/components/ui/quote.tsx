import type { JSX } from 'react'
import * as React from 'react'
import { cva, type VariantProps } from 'class-variance-authority'

import { cn } from '@/lib/utils'

/**
 * Quote — someone else's words, set apart without a side stripe.
 *
 * A quotation in this UI used to be a rule down its left edge
 * (`border-l-2 border-border pl-3`): eleven hand-rolled copies across the cards,
 * the inbox, the review rail and the run log. The product owner prefers boxes
 * without side stripes (2026-10-27), so a quote now reads as a quote by
 * typography and place (design-language.md, "Emphasis without a stripe"):
 *
 *  - `inline` (default): indented and italic in the muted ink. A reviewer's
 *    comment, a question that was asked, a lesson's wording.
 *  - `excerpt`: a passage on a quiet tinted surface with the card radius. The
 *    law's wording in an answer, the one quote whose weight is the point.
 *  - `paraphrase`: the same place, but upright on a dashed hairline: the
 *    server found no passage holding the wording, and the stamp under it says
 *    so in words.
 *
 * Type size is the caller's (`text-xs`, `card-caption`, …): a quote takes the
 * size of the surface it sits in. `as` picks the element; a `<blockquote>` by
 * default, a `<p>` or `<div>` where the words are not a quotation of a source
 * but still someone else's.
 */
const quoteVariants = cva('min-w-0 break-words', {
  variants: {
    variant: {
      inline: 'ps-3 italic text-muted-foreground',
      excerpt: 'rounded-lg bg-muted/60 px-4 py-3 italic text-default',
      paraphrase: 'rounded-lg border border-dashed border-border px-4 py-3 not-italic text-muted-foreground',
    },
  },
  defaultVariants: { variant: 'inline' },
})

export interface QuoteProps extends React.HTMLAttributes<HTMLElement>, VariantProps<typeof quoteVariants> {
  /** Element to render. Defaults to `blockquote`. */
  as?: 'blockquote' | 'p' | 'div' | 'span' | 'section'
}

export function Quote({ as: Comp = 'blockquote', variant, className, ...props }: QuoteProps): JSX.Element {
  return <Comp data-slot="quote" data-variant={variant ?? 'inline'} className={cn(quoteVariants({ variant }), className)} {...props} />
}

export { quoteVariants }
