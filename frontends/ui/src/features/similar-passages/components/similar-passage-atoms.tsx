'use client'

/**
 * The atoms „Ähnliche Stellen" is drawn from: the rail's frame, a group's
 * heading, and one passage as the pressable card the reader opens. The panel
 * composes these and the kit's own (`SemanticMatch`, `SourceSignalChip`,
 * `ProjectClosedChip`), so its shapes live here once.
 */

import type { ButtonHTMLAttributes, JSX, ReactNode } from 'react'
import { forwardRef } from 'react'
import { FOCUS_RING } from '@/components/ui/focus-ring'
import { PRESSABLE } from '@/components/ui/press'
import { cn } from '@/lib/utils'

/**
 * The rail beside the document: a column on a real screen, a band above the
 * document on a phone. The same footprint the citation viewer's Fundstellen
 * rail takes, so swapping one for the other does not move the document.
 */
export function SimilarRail({
  label,
  children,
  className,
}: {
  label: string
  children: ReactNode
  className?: string
}): JSX.Element {
  return (
    <section
      aria-label={label}
      data-testid="similar-passages"
      className={cn('flex max-h-[40dvh] min-h-0 shrink-0 flex-col gap-2 md:max-h-none md:w-72', className)}
    >
      {children}
    </section>
  )
}

/**
 * The scrolling list under the rail's head. `relative` is load-bearing: each
 * passage carries a screen-reader-only relevance line (`sr-only`, absolutely
 * positioned), and without a positioned scroll container those lines escape
 * its clipping, stretch the dialog's own scroll height and scroll the
 * dialog's header out of view.
 */
export function SimilarList({ children }: { children: ReactNode }): JSX.Element {
  return (
    <div className="relative flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto overscroll-contain pb-1">{children}</div>
  )
}

/** One group's heading: where its documents are (a project, the Büroablage), and what is true of it. */
export function SimilarGroupHeading({ children }: { children: ReactNode }): JSX.Element {
  return <h3 className="flex min-w-0 flex-wrap items-center gap-1.5 text-xs font-medium text-foreground">{children}</h3>
}

/** One document's name line, and its Fassung beside it. */
export function SimilarDocumentLine({ name, meta }: { name: string; meta?: ReactNode }): JSX.Element {
  return (
    <p className="flex min-w-0 items-baseline gap-1.5 text-xs">
      <span className="min-w-0 truncate font-medium" title={name}>
        {name}
      </span>
      {meta}
    </p>
  )
}

/** A quiet tag after a document's name: its Fassung („Index C", „Stand 14.08.2026") or „Ältere Fassung". */
export function SimilarTag({ children }: { children: ReactNode }): JSX.Element {
  return <span className="shrink-0 text-[11px] text-muted-foreground">{children}</span>
}

/**
 * One passage, pressable: opens its document at it. `current` marks the one
 * on the stage, in the same way the Fundstellen rail marks the one being read.
 */
export const SimilarPassageButton = forwardRef<
  HTMLButtonElement,
  ButtonHTMLAttributes<HTMLButtonElement> & { current?: boolean }
>(function SimilarPassageButton({ current, className, children, ...props }, ref) {
  return (
    <button
      ref={ref}
      type="button"
      aria-current={current ? 'true' : undefined}
      data-similar-passage=""
      className={cn(
        // `[&>*]:mt-0`: the match block brings its own top margin for a card
        // body; here the button IS its box, so the ring sits on its border.
        'block w-full rounded-lg text-left outline-none [&>*]:mt-0',
        FOCUS_RING,
        PRESSABLE,
        current ? 'ring-2 ring-foreground/50' : 'hover:brightness-[0.98]',
        className
      )}
      {...props}
    >
      {children}
    </button>
  )
})
