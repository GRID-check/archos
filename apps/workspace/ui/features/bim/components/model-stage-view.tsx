


import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog'

import { cn } from '@/lib/utils'
import { documentDisplayName } from '@/lib/documents/display-name'

import type { ModelStageController } from './use-model-stage-controller'
import { ModelStageCanvasLayer, ModelStageChromeLayer } from './model-stage-layers'
import { ModelStageDockLayer } from './model-stage-dock-layer'
import { ModelMarksPanel } from './model-marks-panel'
import { useModelMarks } from '../hooks/use-model-marks'

export function ModelStageView({ controller }: { controller: ModelStageController }) {
  const { advancedOpen, closeAdvanced, compactSheet, layout, model, onClose, phoneSheet, selectedGlobalId, setPhoneSheet, setView, stageRef, t, viewport } = controller
  const marks = useModelMarks(controller)
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent
        ref={stageRef}
        // Full screen on a phone, a large floating window on a desktop. The
        // inset is what makes it read as something that OPENED over Dateien
        // rather than as a navigation — you can still see the page it came
        // from at the edges, which is the difference between a popup and a
        // page, and it is why closing does not feel like going back.
        //
        // `sm:max-w-*` MUST be spelled out: DialogContent's base class ends in
        // `sm:max-w-lg` and a bare `max-w-*` loses to it at exactly the
        // breakpoint where it matters.
        className={cn(
          'flex h-[100dvh] max-h-[100dvh] w-full max-w-full flex-col gap-0 overflow-hidden rounded-none border p-0',
          /*
            The safe area, once, for everything inside.

            The app sets `viewportFit: 'cover'` and leaves the insets to each
            surface; this one is the only full-bleed `100dvh` dialog in the
            product and it had none. On an iPhone that put the dock's pill row
            inside the home-indicator strip — where the system swallows the
            taps — and the Close/Copy pill under the sensor housing in one
            landscape rotation. Every absolutely-positioned child measures from
            the padding box, so padding here moves the dock, the rail, the
            drawer and the close pill together.

            At EVERY width, not only below `sm`: an iPhone turned sideways is
            852 px wide, past `sm`, and has the deepest inset of all — the
            sensor housing takes ~59 px of that edge. On a desktop the insets
            are 0, so it costs nothing there.
          */
          'pt-[env(safe-area-inset-top)] pr-[env(safe-area-inset-right)] pb-[env(safe-area-inset-bottom)] pl-[env(safe-area-inset-left)]',
          layout === 'phone-landscape'
            ? /*
                A phone on its side used to get the desktop window, inset 24 px
                inside a notch that takes 59. Edge to edge instead, the insets
                above doing the rest, and the paper swapped for the canvas's
                colour so the strips beside the notch read as more stage rather
                than as a frame around it.
              */
              'bg-muted sm:h-[100dvh] sm:max-h-[100dvh] sm:w-full sm:max-w-full sm:rounded-none sm:border-0'
            : 'sm:h-[calc(100dvh-3rem)] sm:max-h-[calc(100dvh-3rem)] sm:w-[calc(100vw-3rem)] sm:max-w-[calc(100vw-3rem)] sm:rounded-3xl'
        )}
        showCloseButton={false}
        // Radix focuses the first focusable child on open, which here would be
        // a rail row — so opening a model to LOOK at it would arm a level
        // filter under a focus ring. Focus the panel instead: Escape still
        // closes and Tab still walks the controls in order.
        onOpenAutoFocus={(event) => {
          event.preventDefault()
          ;(event.currentTarget as HTMLElement | null)?.focus()
        }}
        // Escape peels one layer at a time — drawer, then selection, then the
        // stage itself. Without this the outermost dialog wins and one keypress
        // closes the whole model out from under someone who only wanted to
        // dismiss a panel, which is the classic way a layered surface loses
        // people's work.
        onEscapeKeyDown={(event) => {
          // Measuring peels first. The canvas only swallows Escape when a
          // first point is already down, and only while it has focus — from
          // any dock button, the rail or the inspector, Escape fell straight
          // through to the dialog and closed the model. Measurements are
          // deliberately not in the URL, so that discarded every one of them.
          if (viewport.measure.active) {
            event.preventDefault()
            viewport.measure.setActive(false)
          } else if (marks.open) {
            event.preventDefault()
            marks.close()
          } else if (advancedOpen) {
            event.preventDefault()
            // The same restore the drawer's X does. Without it, closing with
            // Escape unmounted the focused heading and left the reader at the
            // top of a fifteen-control dialog, while closing with the button
            // put them back on the toolbar — one action, two behaviours.
            closeAdvanced()
          } else if (phoneSheet !== null) {
            // A tool sheet is put down before the selection behind it.
            event.preventDefault()
            setPhoneSheet(null)
          } else if (selectedGlobalId) {
            event.preventDefault()
            setView({ element: undefined })
          }
        }}
      >
        <DialogTitle className="sr-only">
          {model ? t('stage.dialogLabel', { name: documentDisplayName(model) }) : t('title')}
        </DialogTitle>

        <div
          className="group/stage bg-muted relative min-h-0 flex-1"
          // A phone's bottom sheet covers the middle of the stage; the loading
          // veil reads this to settle in the free strip above it, so its
          // Abbrechen stays on screen and pressable.
          data-sheet={layout === 'phone' && compactSheet ? 'open' : undefined}
        >
          <ModelStageCanvasLayer controller={controller} marks={marks} />
          <ModelStageChromeLayer controller={controller} />
          <ModelMarksPanel marks={marks} />
          <ModelStageDockLayer controller={controller} marks={marks} />
        </div>
      </DialogContent>
    </Dialog>
  )
}
