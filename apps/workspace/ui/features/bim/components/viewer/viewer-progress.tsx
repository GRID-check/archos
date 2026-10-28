'use client'

/**
 * What the reader looks at while a hundred megabytes of building arrives.
 *
 * The old viewport spent this time showing a small grey chip in a corner
 * reading "12.847 Meshes" — a number that is meaningless to an architect,
 * placed where nobody was looking, on top of an empty canvas. Meanwhile the
 * download's real percentage was computed on every chunk and thrown away.
 *
 * So: the percentage is the bar, the bar is in the middle where the building
 * will be, and the wording says what is happening in the reader's terms. The
 * two phases are honest about their difference — a download has a known end
 * and gets a determinate bar; parsing does not and gets a moving one, because
 * a fake percentage that stalls at 90% is worse than no percentage.
 *
 * Rendered OVER the canvas rather than instead of it, so the first triangles
 * appear behind the bar and the reader sees the building assembling itself.
 * That is the difference between waiting and watching.
 */

import type { JSX } from 'react'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'

export interface ViewerProgressProps {
  /** What is happening, in the reader's words. */
  label: string
  /** 0..100 for a determinate bar; null while there is nothing honest to show. */
  percent: number | null
  /**
   * What the number is OF — "37 von 120 MB". On a weak connection the size is
   * what lets someone decide to wait or to stop, which a bare percentage does
   * not give them.
   */
  detail?: string
  /**
   * A way out of the wait. The veil is `pointer-events-none` so the first
   * triangles can be orbited while they arrive, which also meant the only way
   * to abandon a 150 MB download on a bad connection was to close the whole
   * dialog. This is the one part of the veil that takes the pointer.
   */
  cancel?: { label: string; onClick: () => void }
  className?: string
}

export function ViewerProgress({
  label,
  percent,
  detail,
  cancel,
  className,
}: ViewerProgressProps): JSX.Element {
  const determinate = percent !== null && Number.isFinite(percent)
  const clamped = determinate ? Math.min(100, Math.max(0, percent)) : 0

  return (
    <div
      className={cn(
        // `z-10`, BELOW the dock, the sheets and the rail (all `z-20`). At `z-30` the veil
        // drew over a sheet opened during the download: "Modell wird geladen…" and its
        // bar printed across the selection's header.
        'pointer-events-none absolute inset-0 z-10 flex flex-col items-center justify-center gap-3',
        'animate-in fade-in-0 duration-base ease-out motion-reduce:animate-none',
        // A phone's bottom sheet (up to 60dvh) and the tool bar under it take the
        // lower part of the stage: settle in the strip above them instead of
        // under the sheet, where Abbrechen could not be pressed.
        'group-data-[sheet=open]/stage:pt-20 group-data-[sheet=open]/stage:pb-[calc(min(60dvh,34rem)+6rem)]',
        className
      )}
    >
      <p className="text-sm font-medium text-foreground">{label}</p>
      <div
        role="progressbar"
        aria-label={label}
        // A determinate bar reports its position; an indeterminate one reports
        // none at all rather than a zero it would have to keep lying about.
        {...(determinate
          ? { 'aria-valuenow': Math.round(clamped), 'aria-valuemin': 0, 'aria-valuemax': 100 }
          : {})}
        className="h-1 w-48 overflow-hidden rounded-full bg-border"
      >
        <div
          className={cn(
            'h-full rounded-full bg-foreground/70',
            determinate
              ? // `scaleX`, not width: a width tween is a layout animation.
                'w-full origin-left transition-transform duration-quick ease-out motion-reduce:transition-none'
              : // A slow sweep, not a spinner: it says "still working" without
                // claiming a position it does not know.
                'w-1/3 animate-progress-sweep motion-reduce:animate-none'
          )}
          {...(determinate ? { style: { transform: `scaleX(${clamped / 100})` } } : {})}
        />
      </div>
      {/*
        Always occupies the readout line. Download → parse used to unmount the
        percentage and lift the bar by a line; the number is gone, the gap stays.
      */}
      <p className="h-4 text-xs tabular-nums text-muted-foreground">
        {determinate ? `${Math.round(clamped)}%` : null}
        {determinate && detail ? ' · ' : null}
        {detail}
      </p>
      {cancel && (
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="pointer-events-auto"
          onClick={cancel.onClick}
        >
          {cancel.label}
        </Button>
      )}
    </div>
  )
}
