'use client'

/**
 * The canvas's half of a mark on a model, beside its controller.
 *
 * Four jobs, all driven by props because nothing but props crosses the
 * `next/dynamic` boundary the canvas sits behind:
 *
 * 1. the PNG download (`captureNonce`), moved here from the controller;
 * 2. capturing a viewpoint of the live renderer, with its picture
 *    (`bridge.captureNonce`): the same exhaustive frame as the download, then
 *    the camera, the cut, what is shown and what is selected, in IFC world
 *    coordinates (`lib/viewpoint.ts`), and the picture downsized to what the
 *    wire takes (`lib/snapshot.ts`);
 * 3. putting a stored viewpoint back (`bridge.restore`): the camera here, and
 *    the cut, visibility and selection reported to the stage, which owns them;
 * 4. moving the pins over the canvas every frame the controller draws.
 */

import { useEffect, useRef, type RefObject } from 'react'
import type { ViewpointPin } from '@/lib/annotations/viewpoint-types'
import { downsizeSnapshot } from '../lib/snapshot'
import { frameOf } from '../lib/render-frame'
import { boundsCentre } from '../lib/viewer-camera'
import { captureFrameOptions } from '../lib/viewer-performance'
import { captureViewpoint, restoreViewpoint, worldPoint, type CaptureState } from '../lib/viewpoint'
import { finalizeCapture } from '../lib/viewpoint-bridge'
import { onFrameOf, pinPoints, placePins } from '../lib/viewpoint-pins'
import type { BimViewerElement } from '../lib/model-index'
import type { IfcViewerCanvasController } from './use-ifc-viewer-canvas-controller'
import type { IfcViewerCanvasProps } from './use-ifc-viewer-canvas-controller'
import type { RendererLike } from './ifc-viewer-canvas-helpers'
import type { ViewerBridge } from '../lib/viewpoint-bridge'

export type IfcViewerCanvasWithBridgeProps = IfcViewerCanvasProps & { bridge?: ViewerBridge }

/** One complete frame, then the swap chain's picture: no culling, no LOD (`viewer-performance.ts`). */
async function captureExhaustively(controller: IfcViewerCanvasController, renderer: RendererLike): Promise<string | null> {
  renderer.render({ ...controller.frameOptions(), ...captureFrameOptions() })
  return renderer.captureScreenshot()
}

function indexElements(elements: readonly BimViewerElement[]) {
  const byExpressId = new Map<number, BimViewerElement>()
  const expressIdByGlobalId = new Map<string, number>()
  for (const element of elements) {
    byExpressId.set(element.expressId, element)
    expressIdByGlobalId.set(element.globalId, element.expressId)
  }
  return { byExpressId, expressIdByGlobalId }
}

/** The pin a new mark gets: on the selection's centre, else where the middle of the view hits the model. */
function capturePin(controller: IfcViewerCanvasController, renderer: RendererLike, byExpressId: ReadonlyMap<number, BimViewerElement>): ViewpointPin | null {
  const frame = frameOf(renderer)
  const selected = controller.selectedRef.current
  if (selected !== null) {
    const box = renderer.getScene().getEntityBoundingBox(selected)
    const element = byExpressId.get(selected)
    if (box) return { point: worldPoint(boundsCentre(box), frame), ...(element ? { globalId: element.globalId } : {}) }
  }
  const canvas = controller.canvasRef.current
  if (!canvas || !renderer.raycastScene) return null
  try {
    const hit = renderer.raycastScene(canvas.clientWidth / 2, canvas.clientHeight / 2, {
      isolatedIds: controller.isolatedRef.current,
      ...(controller.hiddenRef.current && controller.hiddenRef.current.size > 0 ? { hiddenIds: new Set(controller.hiddenRef.current) } : {}),
    })
    if (!hit) return null
    const element = byExpressId.get(hit.intersection.expressId)
    return { point: worldPoint(hit.intersection.point, frame), ...(element ? { globalId: element.globalId } : {}) }
  } catch {
    return null
  }
}

function captureState(controller: IfcViewerCanvasController, renderer: RendererLike, byExpressId: CaptureState['elementsByExpressId']): CaptureState {
  const camera = renderer.getCamera()
  const canvas = controller.canvasRef.current
  const selected = controller.selectedRef.current
  return {
    camera: {
      position: camera.getPosition(),
      target: camera.getTarget(),
      up: camera.getUp(),
      fovRadians: camera.getFOV(),
      projection: camera.getProjectionMode(),
      orthoHalfHeight: camera.getOrthoSize(),
      aspect: canvas && canvas.clientHeight > 0 ? canvas.clientWidth / canvas.clientHeight : 1,
    },
    section: controller.sectionRef.current ?? null,
    bounds: renderer.getModelBounds() ?? null,
    visibility: { hidden: new Set(controller.hiddenRef.current ?? []), isolated: controller.isolatedRef.current ? new Set(controller.isolatedRef.current) : null },
    selected: selected === null ? new Set<number>() : new Set([selected]),
    frame: frameOf(renderer),
    elementsByExpressId: byExpressId,
  }
}

export function useViewpointBridge(controller: IfcViewerCanvasController, props: IfcViewerCanvasWithBridgeProps, pinLayerRef: RefObject<HTMLDivElement | null>): void {
  const { ready, rendererRef, requestFrame, canvasRef, elementsRef } = controller
  const bridge = props.bridge
  const bridgeRef = useRef(bridge)
  bridgeRef.current = bridge
  const onCaptureRef = useRef(props.onCapture)
  onCaptureRef.current = props.onCapture
  // The controller is a new object every render: read through a ref, so a re-render mid-capture cancels nothing.
  const controllerRef = useRef(controller)
  controllerRef.current = controller
  // A capture runs to its end once its nonce is spent; only unmounting drops its answer.
  const mountedRef = useRef(true)
  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
    }
  }, [])

  // 1. The PNG download. The initial value is skipped, or every mount would capture itself.
  const capturedRef = useRef(props.captureNonce ?? 0)
  useEffect(() => {
    const nonce = props.captureNonce ?? 0
    if (!ready || nonce === capturedRef.current) return
    capturedRef.current = nonce
    const renderer = rendererRef.current
    if (!renderer) {
      onCaptureRef.current?.(null)
      return
    }
    void (async () => {
      let png: string | null = null
      try {
        png = await captureExhaustively(controllerRef.current, renderer)
      } catch {
        png = null
      }
      if (!mountedRef.current) return
      onCaptureRef.current?.(png)
      // Back to the interactive frame, so the viewport is not left showing a capture-quality image.
      requestFrame()
    })()
  }, [props.captureNonce, ready, rendererRef, requestFrame])

  // 2. A viewpoint of what the renderer shows now, with its picture.
  const viewpointRef = useRef(bridge?.captureNonce ?? 0)
  const captureNonce = bridge?.captureNonce ?? 0
  useEffect(() => {
    if (!ready || captureNonce === viewpointRef.current) return
    viewpointRef.current = captureNonce
    const renderer = rendererRef.current
    if (!renderer) {
      bridgeRef.current?.onViewpoint(null)
      return
    }
    void (async () => {
      let capture = null
      try {
        const live = controllerRef.current
        const { byExpressId } = indexElements(elementsRef.current)
        const captured = captureViewpoint(captureState(live, renderer, byExpressId))
        const pin = capturePin(live, renderer, byExpressId)
        const png = await captureExhaustively(live, renderer).catch(() => null)
        const snapshot = png ? await downsizeSnapshot(png) : null
        capture = finalizeCapture(captured, { pin, snapshot })
      } catch {
        capture = null
      }
      if (!mountedRef.current) return
      bridgeRef.current?.onViewpoint(capture)
      requestFrame()
    })()
  }, [captureNonce, ready, rendererRef, elementsRef, requestFrame])

  // 3. A stored viewpoint put back.
  const restoredRef = useRef(bridge?.restore?.nonce ?? 0)
  const restore = bridge?.restore ?? null
  useEffect(() => {
    if (!ready || !restore || restore.nonce === restoredRef.current) return
    restoredRef.current = restore.nonce
    const renderer = rendererRef.current
    if (!renderer) return
    const camera = renderer.getCamera()
    camera.stopInertia()
    const { expressIdByGlobalId } = indexElements(elementsRef.current)
    const restored = restoreViewpoint(restore.viewpoint, camera, { frame: frameOf(renderer), expressIdByGlobalId })
    requestFrame()
    bridgeRef.current?.onRestored(restored)
  }, [restore, ready, rendererRef, elementsRef, requestFrame])

  // 4. The pins, moved to where the camera now puts them.
  const pins = bridge?.pins
  const pointsRef = useRef<ReturnType<typeof pinPoints>>(new Map())
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    return onFrameOf(canvas, (project, size) => {
      const layer = pinLayerRef.current
      if (layer) placePins(layer, pointsRef.current, project, size)
    })
  }, [canvasRef, pinLayerRef])
  useEffect(() => {
    const renderer = rendererRef.current
    if (!ready || !renderer || !pins) {
      pointsRef.current = new Map()
      return
    }
    const { expressIdByGlobalId } = indexElements(elementsRef.current)
    const scene = renderer.getScene()
    pointsRef.current = pinPoints(pins, frameOf(renderer), (globalId) => {
      const id = expressIdByGlobalId.get(globalId)
      return id === undefined ? null : scene.getEntityBoundingBox(id)
    })
    requestFrame()
  }, [pins, ready, rendererRef, elementsRef, requestFrame])
}
