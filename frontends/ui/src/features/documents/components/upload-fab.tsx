import type { JSX, ReactNode } from 'react'
import { cn } from '@/lib/utils'

/**
 * The phone's Hochladen: the uploader's own button, lifted to a floating
 * action at the foot of the screen. The wrapper sizes it and lets only the
 * button take touches, so the list under the rest of the strip still scrolls.
 *
 * `inSheet` is the Archiv, a sheet that reaches the screen's edge and so clears
 * the home indicator itself; a project's Dateien sits above the in-flow tab bar,
 * which owns that inset. The nearest positioned ancestor is the box it floats in.
 */
export function UploadFab({ inSheet, children }: { inSheet: boolean; children: ReactNode }): JSX.Element {
  return (
    <div
      className={cn(
        'pointer-events-none absolute right-4 z-20 [&_button]:pointer-events-auto [&_button]:h-12 [&_button]:rounded-full [&_button]:px-5 [&_button]:shadow-lg',
        inSheet ? 'bottom-[max(1rem,env(safe-area-inset-bottom))]' : 'bottom-4'
      )}
      data-testid="files-upload-fab"
    >
      {children}
    </div>
  )
}
