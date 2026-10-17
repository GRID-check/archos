'use client'

import type { JSX } from 'react'
import { ChevronDown } from 'lucide-react'

import { FOCUS_RING } from '@/components/ui/focus-ring'
import { PRESSABLE } from '@/components/ui/press'
import { cn } from '@/lib/utils'
import { ProjectStatusDot } from './project-switcher'

/**
 * The project's name on a phone, and the door to the switcher sheet.
 *
 * The material is the desktop switcher's trigger (a raised card chip) at 44px,
 * so the same control looks the same on both shapes. It stands in two places:
 * the phone header, and the chat toolbar, whose route has no phone header
 * (`ChatToolbar`). One atom, so the two cannot drift.
 */
export function ProjectPill({
  name,
  label,
  expanded,
  onOpen,
  className,
}: {
  name: string
  label: string
  expanded: boolean
  onOpen: () => void
  className?: string
}): JSX.Element {
  return (
    <button
      type="button"
      onClick={onOpen}
      aria-label={label}
      aria-haspopup="dialog"
      aria-expanded={expanded}
      data-testid="project-pill"
      className={cn(
        'border-border bg-card shadow-xs flex h-11 min-w-0 max-w-[min(100%,20rem)] items-center gap-2.5 rounded-[10px] border pl-3 pr-2.5 text-left outline-none',
        PRESSABLE,
        FOCUS_RING,
        className
      )}
    >
      <ProjectStatusDot active />
      <span className="text-foreground min-w-0 flex-1 truncate text-[15px] font-semibold tracking-[-0.01em]">
        {name}
      </span>
      <ChevronDown className="text-muted-foreground size-4 shrink-0" aria-hidden />
    </button>
  )
}
