'use client'

/**
 * A dialog that belongs to the PAGE (an artifact looked at with full
 * attention, opened from the page: the document review), as opposed to one
 * that interrupts the whole app (a confirm).
 *
 * Alone it is the ordinary modal `Dialog`. Beside a panel docked at the page's
 * start edge (the Postfach, ADR-0148) the panel is not behind it, so the
 * dialog does not lock it: it is not modal, renders no scrim, and working the
 * panel does not close it. Its content places itself on the page with the
 * shell's `--page-inset-start` / `--page-inset-top` (unset when nothing is
 * docked, so `0px`), which a caller's full-page geometry reads.
 */

import type { ComponentProps, JSX } from 'react'

import { Dialog, DialogContent } from '@/components/ui/dialog'
import { useStartDockShown } from '@/components/shell/start-dock'

export function PageDialog(props: ComponentProps<typeof Dialog>): JSX.Element {
  const besidePanel = useStartDockShown()
  return <Dialog modal={!besidePanel} {...props} />
}

export function PageDialogContent({ onInteractOutside, ...props }: ComponentProps<typeof DialogContent>): JSX.Element {
  const besidePanel = useStartDockShown()
  return (
    <DialogContent
      onInteractOutside={(event) => {
        onInteractOutside?.(event)
        // Working the docked panel is not leaving the page's dialog.
        if (besidePanel) event.preventDefault()
      }}
      {...props}
    />
  )
}
