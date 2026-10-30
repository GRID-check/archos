

/**
 * The renderer, typed by the renderer.
 *
 * The declarations below used to be hand-written structural interfaces —
 * `render(options?: Record<string, unknown>)` and a dozen methods copied out by
 * eye — and that is what let every defect this component has shipped through.
 * `xrayContextIds` was not a key the renderer reads; `position: atMetres` was
 * metres in a percentage field. A `Record<string, unknown>` accepts both
 * happily, and neither shows up in a screenshot, so both survived a release.
 *
 * `import type` is erased at build time: it costs nothing in the bundle, does
 * not defeat the `next/dynamic` split this file exists for, and makes the
 * renderer's own `RenderOptions` the contract. A misspelled option is now a
 * type error at the call site, which is where it was always meant to be caught.
 */

import { cn } from '@/lib/utils'
import { REPLAY_BLOCK_CLASS } from '@/lib/analytics/posthog-config'

import type { ReactNode, RefObject } from 'react'
import type { IfcViewerCanvasController } from './use-ifc-viewer-canvas-controller'

export function IfcViewerCanvasView({
  controller,
  pinLayerRef,
  pins,
}: {
  controller: IfcViewerCanvasController
  /** The layer the marks' pins are moved in every frame (`use-viewpoint-bridge.ts`). */
  pinLayerRef?: RefObject<HTMLDivElement | null>
  pins?: ReactNode
}) {
  const { canvasRef, className, dragging, handleDoubleClick, handleKeyDown, handlePointerCancel, handlePointerDown, handlePointerMove, handlePointerUp, hovering, keysId, measuring, overlayLabelsRef, overlaySvgRef, setHovering, t } = controller
  return (
    /*
      The canvas, and the two layers that draw ON it.

      A wrapper rather than a bare `<canvas>` because a dimension line has to
      be drawn in the page, not in the scene — see `measure-overlay.ts` for
      why. Both layers are `pointer-events-none`, so every gesture still
      reaches the canvas underneath and the viewport behaves exactly as it did
      when it was one element.
    */
    <div className={cn('relative', REPLAY_BLOCK_CLASS, className)}>
      <canvas
        ref={canvasRef}
        className={cn(
          // `ring-inset`: the canvas fills a `overflow-hidden` dialog, so an
          // outward ring lands exactly on the clip boundary and is cut off —
          // the viewport is the primary keyboard target and had no visible
          // focus at all. Same fix the repo already uses on `FileCard` and
          // `CodeBlock`.
          // `[-webkit-touch-callout:none]`: `select-none` and the suppressed
          // context menu below cover Android and the desktop right-drag, but
          // not Safari's image action sheet — a `<canvas>` with `role="img"`
          // is an image to iOS, so a finger resting while its owner decides
          // where to measure got "Save Image / Copy" over the building.
          'size-full touch-none select-none [-webkit-touch-callout:none] outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/60',
          // The cursor IS the affordance. A canvas with a text caret over it
          // reads as a picture; a grab hand reads as something you can turn.
          // Measuring gets the crosshair every CAD tool uses, because the
          // click means something completely different there.
          measuring
            ? 'cursor-crosshair'
            : dragging
              ? 'cursor-grabbing'
              : hovering
                ? 'cursor-pointer'
                : 'cursor-grab'
        )}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerCancel={handlePointerCancel}
        onPointerLeave={() => setHovering(false)}
        onDoubleClick={handleDoubleClick}
        onKeyDown={handleKeyDown}
        // Right-drag pans, so the browser's menu must not appear on top of it.
        onContextMenu={(event) => event.preventDefault()}
        // Focusable so the keyboard controls above can be reached at all.
        tabIndex={0}
        // The canvas is a graphical view of data that is also available as text
        // in the element table beside it, so it is labelled rather than
        // described. Through the dictionary like every other string a reader
        // sees: a hardcoded German label is the one piece of the page an
        // English screen reader cannot read.
        role="img"
        aria-label={t('viewer.canvasLabel')}
        // `role="img"` tells assistive technology this is a graphic, so the
        // whole arrow/shift/+/-/F scheme below was undiscoverable: a focusable
        // picture with no hint that it can be driven at all. The description
        // is the only place those keys are written down for a reader who
        // cannot see the building move.
        aria-describedby={keysId}
      />
      <p id={keysId} className="sr-only">
        {t('viewer.keyboardHint')}
      </p>
      <svg
        ref={overlaySvgRef}
        className="pointer-events-none absolute inset-0 size-full overflow-visible"
        // Decorative: the same measurements are published as text beside the
        // dock, in the list the stage renders from `measure.measurements`.
        // (That list did not exist when this comment was first written, and
        // the drawing was the only place a dimension appeared — so every
        // number the tool produced was unreadable to a screen reader.)
        aria-hidden="true"
      />
      <div
        ref={overlayLabelsRef}
        className="pointer-events-none absolute inset-0 overflow-hidden"
        aria-hidden="true"
      />
      {/* Pins are buttons: the layer lets the canvas have every gesture and each pin its own click. */}
      {pinLayerRef && <div ref={pinLayerRef} className="pointer-events-none absolute inset-0 overflow-hidden">{pins}</div>}
    </div>
  )
}
