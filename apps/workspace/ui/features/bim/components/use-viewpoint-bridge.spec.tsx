/**
 * The canvas's half of a mark on a model, against a stand-in ifc-lite (the
 * same shape `ifc-viewer-canvas.spec.tsx` fakes; WebGPU cannot exist here).
 *
 * What it proves: a capture reads the LIVE camera in IFC world coordinates
 * (the stream's offsets included), takes its picture from an exhaustive
 * frame, and answers with exactly what the strict wire takes; a restore puts
 * the camera back and reports the rest; pins move with each drawn frame.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { render, waitFor } from '@testing-library/react'
import { viewpointInputSchema, type ViewpointInput } from '@/lib/annotations/viewpoint-types'
import { IfcViewerCanvas } from './ifc-viewer-canvas'
import type { BimViewerElement } from '../lib/model-index'
import type { ViewerBridge, ViewpointCapture } from '../lib/viewpoint-bridge'

const snapshot = vi.hoisted(() => ({ seen: [] as string[] }))
vi.mock('../lib/snapshot', () => ({
  downsizeSnapshot: async (dataUrl: string) => {
    snapshot.seen.push(dataUrl)
    return { contentType: 'image/jpeg', dataBase64: 'QUFB' }
  },
}))

interface RecordedRender {
  restoreEvictedForCapture?: boolean
  lod?: unknown
  contributionCull?: unknown
}

const renders: RecordedRender[] = []
let capturedFrame = -1
/** While set, `captureScreenshot` waits for it: a capture still in flight when the page re-renders. */
let screenshotGate: Promise<void> | null = null
const RTC = { x: 2683000, y: 1245000, z: 0 }
const WALL = '0AAAAAAAAAAAAAAAAAAAA1'
const SLAB = '0AAAAAAAAAAAAAAAAAAAA2'

/** The camera of the fake renderer: a pose the test sets, and setters that record what a restore wrote. */
const pose = {
  position: { x: 10, y: 5, z: -20 },
  target: { x: 10, y: 5, z: -10 },
  up: { x: 0, y: 1, z: 0 },
}
const camera = {
  orbit: vi.fn(),
  pan: vi.fn(),
  zoom: vi.fn(),
  update: vi.fn(() => false),
  setOrbitCenter: vi.fn(),
  setAspect: vi.fn(),
  zoomExtent: vi.fn(async () => {}),
  frameBounds: vi.fn(async () => {}),
  setPresetView: vi.fn(),
  setProjectionMode: vi.fn(),
  fitBoundsAdaptive: vi.fn(),
  setSceneBounds: vi.fn(),
  stopInertia: vi.fn(),
  projectToScreen: vi.fn((point: { x: number; y: number }) => ({ x: 400 + point.x, y: 300 - point.y })),
  getPosition: () => pose.position,
  getTarget: () => pose.target,
  getUp: () => pose.up,
  getFOV: () => Math.PI / 4,
  getProjectionMode: () => 'perspective' as const,
  getOrthoSize: () => 10,
  getDistance: () => 10,
  setPosition: vi.fn(),
  setTarget: vi.fn(),
  setUp: vi.fn(),
  setFOV: vi.fn(),
  setOrthoSize: vi.fn(),
}

vi.mock('@ifc-lite/renderer', () => ({
  Renderer: class {
    async init(): Promise<void> {}
    addMeshes(): void {}
    async enableQuantizedBatches(): Promise<boolean> {
      return true
    }
    async captureScreenshot(): Promise<string> {
      capturedFrame = renders.length - 1
      if (screenshotGate) await screenshotGate
      return 'data:image/png;base64,AAA'
    }
    fitToView(): void {}
    resize(): void {}
    render(options: RecordedRender): void {
      renders.push(options)
    }
    destroy(): void {}
    async pick(): Promise<null> {
      return null
    }
    raycastScene() {
      return null
    }
    getCamera() {
      return camera
    }
    getModelBounds() {
      return { min: { x: -10, y: -3, z: -10 }, max: { x: 10, y: 9, z: 10 } }
    }
    getScene() {
      return {
        setColorOverrides: vi.fn(),
        clearColorOverrides: vi.fn(),
        // The wall's box: centred at (2, 3, -4) in the render frame.
        getEntityBoundingBox: (id: number) => (id === 21 ? { min: { x: 0, y: 0, z: -6 }, max: { x: 4, y: 6, z: -2 } } : null),
        setLodBuildsEnabled: () => {},
      }
    }
    getGPUDevice() {
      return {}
    }
    getPipeline() {
      return {}
    }
    onDeviceLost() {
      return () => {}
    }
  },
}))

vi.mock('@ifc-lite/geometry', () => ({
  GeometryProcessor: class {
    async init(): Promise<void> {}
    async *processAdaptive(): AsyncGenerator<{ type: string; meshes?: unknown[]; coordinateInfo?: unknown }> {
      // The kernel moved the model near the origin by the georeferenced offset, and says so on the stream.
      yield { type: 'start' }
      yield { type: 'batch', meshes: [{}, {}], coordinateInfo: { wasmRtcOffset: RTC } }
    }
    dispose(): void {}
  },
}))

const ELEMENTS: BimViewerElement[] = [
  { globalId: WALL, expressId: 21, ifcType: 'IfcWall', name: 'Aussenwand', storeyName: 'EG' },
  { globalId: SLAB, expressId: 22, ifcType: 'IfcSlab', name: 'Decke', storeyName: 'EG' },
]

function bridge(patch: Partial<ViewerBridge> = {}): ViewerBridge {
  return { captureNonce: 0, onViewpoint: vi.fn(), restore: null, onRestored: vi.fn(), pins: [], pinNodes: null, ...patch }
}

function canvas(props: { bridge: ViewerBridge; selectedExpressId?: number | null }) {
  return <IfcViewerCanvas sourceUrl="https://example.test/model.ifc" elements={ELEMENTS} {...props} />
}

beforeEach(() => {
  renders.length = 0
  capturedFrame = -1
  screenshotGate = null
  snapshot.seen.length = 0
  const proto = HTMLCanvasElement.prototype as unknown as Record<string, unknown>
  Object.defineProperty(proto, 'clientWidth', { value: 800, configurable: true })
  Object.defineProperty(proto, 'clientHeight', { value: 600, configurable: true })
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => ({ ok: true, status: 200, headers: { get: () => null }, body: null, arrayBuffer: async () => new ArrayBuffer(8) }))
  )
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.clearAllMocks()
})

describe('capturing a viewpoint', () => {
  it('reads the live camera in IFC world coordinates and answers what the wire takes', async () => {
    const onViewpoint = vi.fn<(capture: ViewpointCapture | null) => void>()
    const first = bridge({ onViewpoint })
    const view = render(canvas({ bridge: first, selectedExpressId: 21 }))
    await waitFor(() => expect(renders.length).toBeGreaterThan(0))

    view.rerender(canvas({ bridge: { ...first, captureNonce: 1 }, selectedExpressId: 21 }))
    await waitFor(() => expect(onViewpoint).toHaveBeenCalled())

    const capture = onViewpoint.mock.calls[0]?.[0]
    if (!capture) throw new Error('no capture')
    const viewpoint: ViewpointInput = capture.viewpoint
    expect(viewpointInputSchema.safeParse(viewpoint).success).toBe(true)
    expect(viewpoint).not.toHaveProperty('truncated')
    // Render (10, 5, -20) is Z-up (10, 20, 5), plus the stream's offset.
    expect(viewpoint.camera.position).toEqual({ x: 2683010, y: 1245020, z: 5 })
    expect(viewpoint.camera.direction).toEqual({ x: 0, y: -1, z: 0 })
    expect(viewpoint.components.selection.globalIds).toEqual([WALL])
    // The pin stands on the selected wall's centre, in world coordinates.
    expect(viewpoint.pin).toEqual({ point: { x: 2683002, y: 1245004, z: 3 }, globalId: WALL })
    expect(viewpoint.snapshot).toEqual({ contentType: 'image/jpeg', dataBase64: 'QUFB' })
    expect(snapshot.seen).toEqual(['data:image/png;base64,AAA'])
    // The picture is the exhaustive frame drawn just before it.
    expect(renders[capturedFrame]?.restoreEvictedForCapture).toBe(true)
    expect(renders[capturedFrame]?.lod).toBeUndefined()
  })

  it('does not capture itself on mount', async () => {
    const onViewpoint = vi.fn()
    render(canvas({ bridge: bridge({ captureNonce: 3, onViewpoint }) }))
    await waitFor(() => expect(renders.length).toBeGreaterThan(0))
    expect(onViewpoint).not.toHaveBeenCalled()
  })
})

describe('a re-render while a capture is in flight', () => {
  function gate(): () => void {
    let open = () => {}
    screenshotGate = new Promise<void>((resolve) => {
      open = resolve
    })
    return open
  }

  it('still answers the viewpoint: the spent nonce is not cancelled by a new controller', async () => {
    const onViewpoint = vi.fn<(capture: ViewpointCapture | null) => void>()
    const first = bridge({ onViewpoint })
    const view = render(canvas({ bridge: first }))
    await waitFor(() => expect(renders.length).toBeGreaterThan(0))

    const open = gate()
    view.rerender(canvas({ bridge: { ...first, captureNonce: 1 } }))
    await waitFor(() => expect(capturedFrame).toBeGreaterThanOrEqual(0))
    // The stage re-renders mid-capture (a new bridge object, a new controller), as the panel's spinner makes it.
    view.rerender(canvas({ bridge: { ...first, captureNonce: 1, pins: [] } }))
    view.rerender(canvas({ bridge: { ...first, captureNonce: 1 }, selectedExpressId: 22 }))
    open()

    await waitFor(() => expect(onViewpoint).toHaveBeenCalledTimes(1))
    expect(onViewpoint.mock.calls[0]?.[0]).not.toBeNull()
  })

  it('still answers the PNG download', async () => {
    const onCapture = vi.fn()
    const view = render(<IfcViewerCanvas sourceUrl="https://example.test/model.ifc" elements={ELEMENTS} captureNonce={0} onCapture={onCapture} />)
    await waitFor(() => expect(renders.length).toBeGreaterThan(0))

    const open = gate()
    view.rerender(<IfcViewerCanvas sourceUrl="https://example.test/model.ifc" elements={ELEMENTS} captureNonce={1} onCapture={onCapture} />)
    await waitFor(() => expect(capturedFrame).toBeGreaterThanOrEqual(0))
    view.rerender(<IfcViewerCanvas sourceUrl="https://example.test/model.ifc" elements={ELEMENTS} captureNonce={1} onCapture={onCapture} className="x" />)
    open()

    await waitFor(() => expect(onCapture).toHaveBeenCalledWith('data:image/png;base64,AAA'))
  })
})

describe('restoring a viewpoint', () => {
  it('puts the camera back in the render frame and reports cut, visibility and what is missing', async () => {
    const onRestored = vi.fn()
    const first = bridge({ onRestored })
    const view = render(canvas({ bridge: first }))
    await waitFor(() => expect(renders.length).toBeGreaterThan(0))

    const viewpoint: ViewpointInput = {
      camera: {
        type: 'perspective',
        position: { x: 2683010, y: 1245020, z: 5 },
        direction: { x: 0, y: -1, z: 0 },
        up: { x: 0, y: 0, z: 1 },
        fieldOfView: 60,
        aspectRatio: 1.5,
      },
      clippingPlanes: [{ location: { x: 2683000, y: 1245000, z: 1.5 }, direction: { x: 0, y: 0, z: 1 } }],
      components: {
        selection: { globalIds: [WALL, '0AAAAAAAAAAAAAAAAAAAA9'] },
        visibility: { defaultVisibility: true, exceptions: [SLAB] },
        coloring: [],
      },
    }
    view.rerender(canvas({ bridge: { ...first, restore: { nonce: 1, viewpoint } } }))
    await waitFor(() => expect(onRestored).toHaveBeenCalled())

    expect(camera.stopInertia).toHaveBeenCalled()
    expect(camera.setPosition).toHaveBeenCalledWith(10, 5, -20)
    expect(camera.setFOV).toHaveBeenCalledWith(Math.PI / 3)
    const restored = onRestored.mock.calls[0]?.[0]
    expect(restored.missing).toBe(1)
    expect(restored.section).toEqual({ atMetres: 1.5, flipped: false })
    expect([...restored.visibility.hidden]).toEqual([22])
    expect([...restored.selected]).toEqual([21])
  })
})

describe('pins', () => {
  it('moves a pin to where the camera projects its point, every frame', async () => {
    const pins = [{ id: 'mark-1', world: null, globalIds: [WALL] }]
    const pinNodes = <div data-pin-id="mark-1" data-testid="pin" style={{ visibility: 'hidden' }} />
    const view = render(canvas({ bridge: bridge({ pins, pinNodes }) }))
    // The wall's centre (2, 3, -4) through the fake projector: (402, 297).
    await waitFor(() => expect(view.getByTestId('pin').style.transform).toBe('translate(402px, 297px)'))
    expect(view.getByTestId('pin').style.visibility).toBe('visible')
  })
})
