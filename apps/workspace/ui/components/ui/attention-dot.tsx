import type { JSX } from 'react'

import { cn } from '@/lib/utils'

/**
 * AttentionDot — the small ink dot on a control whose menu holds something new
 * (the avatar, the phone's „Mehr" tab), when a number would be too much for the
 * spot and the count lives one level down, on the row itself.
 *
 * The same ink as `CountPill`'s `attention` tone, with a ring in the surface
 * colour so it reads on top of an avatar disc or a glyph. Nothing at all when
 * `show` is false: an empty dot reads as a bug. The caller places the dot
 * (`absolute` and an offset). Inside a control that names itself
 * (`aria-label`), the control's name says it and the dot is hidden; elsewhere
 * `label` makes it a polite status a screen reader hears.
 */
export function AttentionDot({
  show,
  label,
  className,
}: {
  show: boolean
  label?: string
  className?: string
}): JSX.Element | null {
  if (!show) return null
  return (
    <span
      role={label ? 'status' : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
      data-slot="attention-dot"
      className={cn('bg-primary ring-background pointer-events-none block size-2.5 rounded-full ring-2', className)}
    />
  )
}
