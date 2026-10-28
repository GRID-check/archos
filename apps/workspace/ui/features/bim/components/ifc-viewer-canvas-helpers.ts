

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
import type { Camera, Renderer, SceneContents } from '@ifc-lite/renderer'

/**
 * What this component uses of the renderer — the real types, narrowed.
 *
 * Narrowed rather than `Renderer` itself for one reason: the class carries
 * private fields, so a structural stand-in can never satisfy it and the specs
 * would have to cast their fake through `unknown`, which throws away exactly
 * the checking this exists for. Each member below is `Renderer`'s own
 * signature, so a change in the package still lands here as a type error.
 */
export type RendererLike = Pick<
  Renderer,
  | 'init'
  | 'addMeshes'
  | 'fitToView'
  | 'render'
  | 'resize'
  | 'destroy'
  | 'pick'
  | 'raycastScene'
  | 'onDeviceLost'
  | 'getModelBounds'
  | 'getGPUDevice'
  | 'getPipeline'
  | 'captureScreenshot'
  | 'enableQuantizedBatches'
> & {
  getCamera(): CameraLike
  getScene(): SceneLike
}

/** The camera surface this component drives. Signatures are `Camera`'s own. */
export type CameraLike = Pick<
  Camera,
  /**
   * `addVelocity` feeds the renderer's own inertia system. Omitting it — which
   * the old hand-written declaration forced, by not declaring the parameter —
   * makes every drag a raw per-event jump with no momentum and no damping.
   */
  | 'orbit'
  | 'pan'
  /**
   * The cursor arguments are the difference between "zoom toward what I am
   * pointing at" and "zoom toward the middle of the screen, and watch the
   * detail I wanted slide off the edge". They were absent from the old
   * declaration, so the call site could not pass them and nobody could see
   * that the renderer had supported it all along.
   */
  | 'zoom'
  /**
   * Advance inertia and any running tween; true while still moving.
   *
   * Nothing called this, which is why momentum never existed AND why
   * `zoomExtent` and the preset views did not animate: both are tweens that
   * only advance when something drives them, and the on-demand renderer drew
   * exactly one frame and stopped.
   */
  | 'update'
  /** Rotate about this point instead of the scene centre. `null` restores it. */
  | 'setOrbitCenter'
  | 'setAspect'
  /** Zoom to fit a box while KEEPING the current view direction. */
  | 'frameBounds'
  | 'zoomExtent'
  | 'setPresetView'
  | 'setProjectionMode'
  /** Adaptive home pose — isometric for a building, along-axis for a corridor. */
  | 'fitBoundsAdaptive'
  | 'stopInertia'
  | 'setSceneBounds'
  /** World point → canvas pixel, for the DOM overlays drawn over the model. */
  | 'projectToScreen'
  | 'getPosition'
  | 'getFOV'
  | 'enableFirstPersonMode'
  | 'moveFirstPerson'
>

export type SceneLike = Pick<
  SceneContents,
  | 'setColorOverrides'
  | 'clearColorOverrides'
  | 'getEntityBoundingBox'
  | 'setLodBuildsEnabled'
  /**
   * What turns the streaming fragments into batches that can carry an LOD1
   * range — without it `setLodBuildsEnabled` above has nothing to build for.
   * See the call in the load effect.
   */
  | 'finalizeStreamingAsync'
>

/**
 * How long one synchronous hover raycast may take before hover is abandoned.
 *
 * The first `raycastScene` on a model builds a BVH over every triangle, and on
 * a large building that is not a frame's worth of work. Rather than guess a
 * size threshold, the first call is TIMED: if it blew the budget, hover turns
 * itself off for this model and the viewport keeps its cursor as a grab hand.
 * Losing a cursor affordance is a much smaller failure than a viewport that
 * stutters whenever the mouse moves.
 */
export const HOVER_BUDGET_MS = 24

/** Pixels of orbit per arrow-key press. One press should be visible, not violent. */
export const KEY_ORBIT_PX = 24
export const KEY_PAN_PX = 32

/**
 * The model's vertical extent, in the renderer's own Y-up world metres.
 *
 * One reader for two consumers that MUST agree: the cut slider's range, and
 * the plane the cut resolves to. When those two disagree the readout lies —
 * which is the whole class of bug the section plane kept landing in.
 */
export function modelBoundsMetres(
  renderer: RendererLike | null
): { minMetres: number; maxMetres: number } | null {
  const bounds = renderer?.getModelBounds()
  if (!bounds) return null
  if (!Number.isFinite(bounds.min.y) || !Number.isFinite(bounds.max.y)) return null
  return { minMetres: bounds.min.y, maxMetres: bounds.max.y }
}
