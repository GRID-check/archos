

import { type BimViewerElement, type ViewerVisibility } from '../lib/model-index'
import { type BimModelView } from '../lib/model-link'

import { useModelViewport } from '../hooks/use-model-viewport'

/** One shared empty array, so "no elements yet" has a stable identity. */
export const NO_ELEMENTS: readonly BimViewerElement[] = []

/**
 * How many steps back the stage remembers.
 *
 * A bound rather than a policy: nobody presses Undo forty times, and an
 * unbounded array of views and id sets held for as long as a model is open is
 * a leak with no upper limit on a surface people leave open all day.
 */
export const STAGE_HISTORY_DEPTH = 40

/**
 * One thing the reader changed on purpose, and how to put it back.
 *
 * Two halves, because the stage's state has two homes. The view is the URL —
 * which model, which level, which element, where the cut is — and taking a
 * step back through it is a navigation. What has been taken out of the way is
 * deliberately NOT in the URL (see `ModelVisibility`), so a step through that
 * is a state the viewport is handed back.
 *
 * Either half is `null` when the step did not touch it, which is what makes
 * one press undo one action: going back over a level filter must not also
 * restore the elements the reader hid afterwards. Both are filled when one
 * gesture changed both — see `asOneStep`.
 */
export interface StageStep {
  view: BimModelView | null
  visibility: ViewerVisibility | null
}

/**
 * Where the legend sits, given how many pills the dock has stacked above
 * itself.
 *
 * Written out as whole class strings rather than composed, because Tailwind
 * scans source text: a computed `bottom-${n}` produces no CSS at all.
 */
export const DOCK_ABOVE_OFFSET: Record<0 | 1 | 2, string> = {
  0: 'bottom-20 sm:bottom-24',
  1: 'bottom-36 sm:bottom-40',
  2: 'bottom-52 sm:bottom-56',
}

/**
 * Hide and isolate, bound to whatever is selected right now.
 *
 * Both are omitted rather than disabled when nothing is selected: the card
 * they live on only exists when there IS a selection, so a disabled pair would
 * be a state the reader can never reach — except in the one frame between
 * hiding the selected element and the selection clearing itself, which is
 * exactly when a live button would act on a component that is already gone.
 *
 * ## Why the two verbs read two different ids
 *
 * Hiding needs the element to be ON SCREEN. "Take this out of the way" said
 * about something already out of the way is not an act, and the id it would
 * use is the renderer's, which is deliberately null the moment a selection
 * stops being drawn.
 *
 * Isolating does not — with one exception. "Show me nothing but this" is
 * exactly what a reader means about an element that is not currently visible
 * BECAUSE SOMETHING ELSE IS ISOLATED, which is the only way to reach that
 * state through the rail. Reading the renderer's id for both left that card
 * with no visibility controls at all: the reader had isolated one wall,
 * picked another to look at, and arrived at a card whose two buttons had
 * silently disappeared — the isolate button among them, which is what would
 * have got them out.
 *
 * The exception is an element the reader HID. Isolating that means "show
 * nothing but this thing I have also taken away", and the honest rendering of
 * it is an empty viewport. So a hidden selection offers neither verb, exactly
 * as it did before isolate learned to read past the renderer.
 */
export function visibilityActions(
  viewport: ReturnType<typeof useModelViewport>,
  clearSelection: () => void,
  focusViewport: () => void,
  asOneStep: (gesture: () => void) => void
): { onHide?: () => void; onIsolate?: () => void; isolated?: boolean } {
  const elementId = viewport.selectedElementExpressId
  if (elementId === null || viewport.visibility.hidden.has(elementId)) return {}
  const isolated = viewport.visibility.isolated
  const actions = {
    // The MANUAL isolation only, never the level filter — the filter isolates
    // a whole floor and this button did not do it, so a button reporting
    // itself pressed for it would be claiming an act it cannot take back.
    isolated: isolated !== null && isolated.size === 1 && isolated.has(elementId),
    onIsolate: () => viewport.visibility.isolate([elementId]),
  }

  const expressId = viewport.selectedExpressId
  if (expressId === null) return actions
  return {
    ...actions,
    // Hiding CLEARS the selection. The card is mounted on the URL's
    // `element=`, not on the renderer id, so without this the reader hid a
    // wall and kept a card describing it — the highlight gone, the pivot
    // reset, and the Hide button itself silently removed from the card that
    // was still open.
    //
    // Both writes are ONE step, so one Undo puts the wall back AND re-opens
    // the card describing it — the state the reader was actually in.
    onHide: () => {
      asOneStep(() => {
        viewport.visibility.hide(expressId)
        clearSelection()
      })
      // Hide destroys the card the button lives in. Without this the reader's
      // focus ring is thrown to the top of a full-screen dialog holding
      // fifteen controls, with nothing said about what happened — the control
      // vanishing IS the only feedback, and it takes their place with it.
      focusViewport()
    },
  }
}
