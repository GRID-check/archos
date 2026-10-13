import type { JSX } from 'react'
import { Sparkles } from 'lucide-react'
import { cn } from '@/lib/utils'

const SIZES = {
  xs: 'size-5 [&_svg]:size-2.5',
  sm: 'size-6 [&_svg]:size-3',
  md: 'size-7 [&_svg]:size-3.5',
} as const

/**
 * PilotiGlyph — Piloti's face wherever a person would show theirs: an ink disc
 * with its spark. Piloti never wears a person's avatar or an identity colour;
 * ink is its colour on the pages too (its marks, its pointer, the boxes it was
 * asked about).
 *
 * `working`: Piloti is busy right now; a soft ring breathes around the disc
 * (still under reduced motion).
 */
export function PilotiGlyph({
  size = 'sm',
  working,
  className,
  label,
}: {
  size?: keyof typeof SIZES
  working?: boolean
  className?: string
  /** For a glyph that stands alone; beside the name „Piloti" it is decoration. */
  label?: string
}): JSX.Element {
  return (
    <span
      role={label ? 'img' : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
      data-slot="piloti-glyph"
      className={cn(
        'bg-foreground text-background relative inline-flex shrink-0 items-center justify-center rounded-full',
        SIZES[size],
        className
      )}
    >
      <Sparkles aria-hidden />
      {working && (
        <span
          aria-hidden
          className="border-foreground/50 absolute -inset-[3px] animate-caret-breathe rounded-full border motion-reduce:animate-none"
        />
      )}
    </span>
  )
}
