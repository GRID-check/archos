import type { JSX, ReactNode } from 'react'
import { cn } from '@/lib/utils'

/**
 * LiveCursor — somebody else's pointer on a shared canvas: the arrow in their
 * colour, and their name on a tag beside it.
 *
 * Its tip is the top-left of the element, so the caller places it with
 * `left`/`top` on the point and nothing else. Motion is the caller's: the
 * pointer arrives a dozen times a second and the caller glides between the
 * samples.
 *
 * `busy`: they are about to set a mark (a point or a region tool in hand), so
 * the tag says so with a glyph: the room sees a colleague take aim before the
 * mark lands, the way people round a table see a pen come down.
 */
export function LiveCursor({
  color,
  label,
  icon,
  busy,
  className,
}: {
  color: string
  label: string
  icon?: ReactNode
  busy?: ReactNode
  className?: string
}): JSX.Element {
  return (
    <span data-slot="live-cursor" className={cn('pointer-events-none absolute top-0 left-0 block', className)}>
      <svg
        aria-hidden
        width="18"
        height="20"
        viewBox="0 0 18 20"
        className="block drop-shadow-[0_1px_1.5px_rgb(0_0_0/0.35)]"
      >
        <path
          d="M1.5 1.5 L1.5 16.2 L5.6 12.6 L8.4 18.6 L11.1 17.4 L8.4 11.5 L14 11.5 Z"
          fill={color}
          stroke="white"
          strokeWidth="1.4"
          strokeLinejoin="round"
        />
      </svg>
      <span
        className="absolute top-[15px] left-[12px] inline-flex max-w-44 items-center gap-1 rounded-full rounded-tl-sm px-2 py-0.5 text-[11px] leading-4 font-medium whitespace-nowrap text-white shadow-md"
        style={{ backgroundColor: color }}
      >
        {icon}
        <span className="truncate">{label}</span>
        {busy}
      </span>
    </span>
  )
}
