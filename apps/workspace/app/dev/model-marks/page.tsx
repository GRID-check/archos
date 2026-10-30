'use client'

/**
 * Dev preview for Anmerkungen on a model: the marks panel and the pins, against
 * the REAL `useModelMarks`, review hook, cards and typed client.
 *
 * Headless Chromium has no WebGPU, so there is no building and no renderer:
 * the canvas's half of the bridge is played here. A capture answers with a
 * fixture viewpoint (and the notices the switches below ask for), a restore
 * answers with what a renderer would have found, and the pins are placed once
 * on a flat stand-in projection over a drawn backdrop. The dock buttons that
 * open this panel ship in the whole stage: `/dev/bim-stage`.
 *
 * A `fetch` shim answers the annotations API from memory: the list, setting a
 * mark (the new one lands in the list), the viewpoint and the snapshot (an SVG
 * stand-in for the JPEG).
 *
 * Routes:
 *   /dev/model-marks                       the list: two open marks, one done
 *   /dev/model-marks?mark=mark-1           a link with `mark`: its thread, its picture,
 *                                          and the view put back („2 Bauteile … nicht enthalten“)
 *   /dev/model-marks?compose=1             the composer on a captured view
 *   /dev/model-marks?compose=1&cut=1       … whose capture could not keep everything
 *   /dev/model-marks?empty=1               no marks yet
 *   /dev/model-marks?empty=1&readonly=1    no marks, and the reader may not set one
 *
 * Not linked from anywhere and 404s outside development (`../layout.tsx`).
 */

import { Suspense, useEffect, useMemo, useRef, type JSX } from 'react'
import { useSearchParams } from 'next/navigation'
import { I18nProvider } from '@/i18n'
import { ModelMarksPanel } from '@/features/bim/components/model-marks-panel'
import { useModelMarks, type ModelMarksStage } from '@/features/bim/hooks/use-model-marks'
import { placePins } from '@/features/bim/lib/viewpoint-pins'
import type { AnnotationView } from '@/lib/annotations/types'
import type { ViewpointInput, ViewpointView } from '@/lib/annotations/viewpoint-types'

const DOCUMENT_ID = 'dev-model-doc'
const WALL = '2O2Fr$t4X7Zf8NOew3FLOH'
const BEAM = '1kTvXnbbzCWw8lcMd1dR4o'
const COLUMN = '3cUkl32yn9qRSPvBJVyWYp'

const ELEMENTS = [
  { globalId: WALL, expressId: 101, ifcType: 'IfcWall', name: 'Außenwand Nord', storeyName: 'EG' },
  { globalId: BEAM, expressId: 102, ifcType: 'IfcBeam', name: 'Unterzug UZ 3', storeyName: 'EG' },
  { globalId: COLUMN, expressId: 103, ifcType: 'IfcColumn', name: 'Stütze S 4', storeyName: 'EG' },
]

const base = {
  documentId: DOCUMENT_ID,
  anchor: 'viewpoint' as const,
  page: null,
  shape: null,
  x: null,
  y: null,
  w: null,
  h: null,
  basis: null,
  authorKind: 'person' as const,
  assigneeUserId: null,
  assigneeName: null,
  dueOn: null,
  revisionNumber: 3,
  onCurrentRevision: true,
  createdBy: 'user_anna',
  createdByName: 'Anna Berger',
  createdAt: '2026-10-28T09:12:00.000Z',
  updatedAt: '2026-10-28T09:12:00.000Z',
  acceptedBy: null,
  acceptedByName: null,
  closedBy: null,
  closedByName: null,
  closedAt: null,
  delegatedBy: null,
  delegatedByName: null,
  delegatedAt: null,
  replies: [],
  canEdit: true,
  canDelete: true,
}

const MARKS: AnnotationView[] = [
  {
    ...base,
    id: 'mark-1',
    number: 1,
    kind: 'defect',
    status: 'open',
    body: 'Auflager fehlt: der Unterzug liegt über Achse C auf keiner Stütze auf.',
    assigneeUserId: 'user_max',
    assigneeName: 'Max Huber',
    dueOn: '2026-11-06',
    viewpoint: { id: 'vp-1', cameraKind: 'perspective', selectionCount: 3, hasSection: true, hasSnapshot: true },
  },
  {
    ...base,
    id: 'mark-2',
    number: 2,
    kind: 'question',
    status: 'open',
    body: 'Ist die Brüstungshöhe im Schnitt richtig dargestellt?',
    viewpoint: { id: 'vp-2', cameraKind: 'orthographic', selectionCount: 0, hasSection: false, hasSnapshot: false },
  },
  {
    ...base,
    id: 'mark-3',
    number: 3,
    kind: 'hint',
    status: 'resolved',
    body: 'Dämmstärke an der Attika ergänzt.',
    closedBy: 'user_max',
    closedByName: 'Max Huber',
    closedAt: '2026-10-29T15:40:00.000Z',
    viewpoint: { id: 'vp-3', cameraKind: 'perspective', selectionCount: 1, hasSection: false, hasSnapshot: false },
  },
]

const CAMERA: ViewpointView['camera'] = {
  type: 'perspective',
  position: { x: 12, y: -18, z: 9 },
  direction: { x: -0.4, y: 0.8, z: -0.45 },
  up: { x: 0, y: 0, z: 1 },
  fieldOfView: 50,
  aspectRatio: 1.6,
}

function viewpointOf(id: string): ViewpointView {
  const index = Number(id.replace(/\D/g, '')) || 1
  return {
    id: `vp-${index}`,
    documentId: DOCUMENT_ID,
    versionId: null,
    camera: CAMERA,
    clippingPlanes: index === 1 ? [{ location: { x: 0, y: 0, z: 1.2 }, direction: { x: 0, y: 0, z: 1 } }] : [],
    components: {
      selection: { globalIds: index === 1 ? [BEAM, COLUMN, '0AAAAAAAAAAAAAAAAAAAA9'] : [] },
      visibility: { defaultVisibility: true, exceptions: [] },
      coloring: [],
    },
    // Mark 2 has no stored point: its pin stands on its elements' centre, which this stand-in has none of.
    pin: { point: { x: index * 4 - 6, y: 0, z: index === 2 ? 4 : 2 }, globalId: BEAM },
    hasSnapshot: index === 1,
    createdAt: '2026-10-28T09:12:00.000Z',
  }
}

/** The picture of mark 1: an SVG stand-in, since the real one is a JPEG the renderer took. */
const SNAPSHOT_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="1500" height="844" viewBox="0 0 1500 844">
<rect width="1500" height="844" fill="#e8ecef"/><polygon points="300,640 750,760 1200,640 750,520" fill="#c9d1d8"/>
<rect x="420" y="300" width="660" height="40" fill="#8a96a3"/><rect x="460" y="340" width="34" height="300" fill="#a3adb7"/>
<rect x="1010" y="340" width="34" height="300" fill="#f59e0b"/><circle cx="750" cy="320" r="18" fill="#dc2626"/></svg>`

if (typeof window !== 'undefined' && process.env.NODE_ENV === 'development') {
  const w = window as unknown as { __modelMarksShim?: boolean }
  if (!w.__modelMarksShim) {
    w.__modelMarksShim = true
    const params = new URLSearchParams(window.location.search)
    const list: AnnotationView[] = params.has('empty') ? [] : [...MARKS]
    const real = window.fetch.bind(window)
    window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
      const method = (init?.method ?? 'GET').toUpperCase()
      const path = url.split('?')[0] ?? url
      if (path.endsWith(`/api/documents/${DOCUMENT_ID}/annotations`)) {
        if (method === 'POST') {
          const body = JSON.parse(String(init?.body ?? '{}')) as { kind: AnnotationView['kind']; body: string; viewpoint?: ViewpointInput }
          const number = list.reduce((most, mark) => Math.max(most, mark.number), 0) + 1
          const created: AnnotationView = {
            ...base,
            id: `mark-${number}`,
            number,
            kind: body.kind,
            body: body.body,
            status: 'open',
            createdBy: 'user_me',
            createdByName: 'Miriam Hofer',
            viewpoint: { id: `vp-${number}`, cameraKind: 'perspective', selectionCount: 1, hasSection: false, hasSnapshot: Boolean(body.viewpoint?.snapshot) },
          }
          list.push(created)
          return Response.json({ annotation: created }, { status: 201 })
        }
        return Response.json({ annotations: list, canAnnotate: !params.has('readonly'), pilotiWakes: false })
      }
      const viewpoint = path.match(/\/annotations\/([^/]+)\/viewpoint$/)
      if (viewpoint) return Response.json({ viewpoint: viewpointOf(viewpoint[1] ?? '') })
      if (/\/annotations\/[^/]+\/snapshot$/.test(path)) return new Response(SNAPSHOT_SVG, { headers: { 'content-type': 'image/svg+xml' } })
      if (path.includes('/api/inbox/unread-anchors')) return Response.json({ anchorIds: [] })
      if (path.endsWith('/api/realtime/send')) return new Response(null, { status: 204 })
      return real(input, init)
    }
  }
}

/** The capture a renderer would answer with: the stand-in camera, the beam selected, a pin on it. */
const CAPTURED: ViewpointInput = {
  camera: CAMERA,
  clippingPlanes: [],
  components: { selection: { globalIds: [BEAM] }, visibility: { defaultVisibility: true, exceptions: [] }, coloring: [] },
  pin: { point: { x: 0, y: 0, z: 3 }, globalId: BEAM },
}

/** The flat stand-in projection: world X right, Z up, 40 px a metre, around the backdrop's middle. */
const project = (point: { x: number; y: number; z: number }) => ({ x: 400 + point.x * 40, y: 300 + point.y * 40 })

function Preview(): JSX.Element {
  const search = useSearchParams()
  const markInLink = search.get('mark') ?? undefined
  const compose = search.has('compose')
  const cut = search.has('cut')
  const setViewLog = useRef<unknown[]>([])
  const stage = useMemo<ModelMarksStage>(
    () => ({
      model: {
        id: 'dev-model',
        documentId: DOCUMENT_ID,
        projectId: 'dev-project',
        filename: 'tragwerk_rev3.ifc',
        displayName: null,
        status: 'ready',
        schemaVersion: 'IFC4',
        elementCount: ELEMENTS.length,
        errorMessage: null,
        summary: null,
        updatedAt: '2026-10-28T09:00:00.000Z',
      },
      modelId: 'dev-model',
      elementList: ELEMENTS,
      elementsLoading: false,
      view: markInLink ? { mark: markInLink } : {},
      setView: (patch) => {
        setViewLog.current.push(patch)
      },
      canCollaborate: true,
      viewport: {
        camera: { view: 'iso', section: null, orthographic: false },
        visibility: { restore: () => {} },
        status: { phase: 'ready' },
      },
    }),
    [markInLink]
  )
  const marks = useModelMarks(stage)
  const bridge = marks.bridge

  // The open panel, as the dock's list button leaves it.
  const opened = useRef(false)
  useEffect(() => {
    if (opened.current) return
    opened.current = true
    if (compose) marks.startMark()
    else marks.setOpen(true)
  }, [compose, marks])

  // The canvas's half: answer a capture, answer a restore as a renderer that lacks two of the elements would.
  const answered = useRef({ capture: 0, restore: 0 })
  useEffect(() => {
    if (!bridge) return
    if (bridge.captureNonce > answered.current.capture) {
      // Marked answered when the answer goes out: a cleared timer (a re-run effect) leaves it to the next run.
      const nonce = bridge.captureNonce
      const timer = window.setTimeout(() => {
        answered.current.capture = nonce
        bridge.onViewpoint({
          viewpoint: cut ? { ...CAPTURED, components: { ...CAPTURED.components, visibility: { defaultVisibility: true, exceptions: [] } } } : CAPTURED,
          notices: { selectionCut: false, visibilityDropped: cut, noSnapshot: cut },
        })
      }, 600)
      return () => window.clearTimeout(timer)
    }
    if (bridge.restore && bridge.restore.nonce > answered.current.restore) {
      answered.current.restore = bridge.restore.nonce
      bridge.onRestored({ missing: 2, section: { atMetres: 1.2, flipped: false }, visibility: { hidden: new Set(), isolated: null }, selected: new Set([102]), ignoredPlanes: 0 })
    }
  }, [bridge, cut])

  // The snapshot is an `<img>`, which the `fetch` shim cannot answer: point it at the stand-in picture instead.
  useEffect(() => {
    const swap = () => {
      for (const image of document.querySelectorAll<HTMLImageElement>('[data-testid="mark-snapshot"]')) {
        if (!image.src.startsWith('data:')) image.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(SNAPSHOT_SVG)}`
      }
    }
    swap()
    const observer = new MutationObserver(swap)
    observer.observe(document.body, { childList: true, subtree: true })
    return () => observer.disconnect()
  }, [])

  // The pins, placed once on the stand-in projection (a renderer moves them every frame).
  const layer = useRef<HTMLDivElement | null>(null)
  const pins = bridge?.pins
  useEffect(() => {
    if (!layer.current || !pins) return
    const points = new Map(pins.flatMap((pin) => (pin.world ? [[pin.id, { x: pin.world.x, y: -pin.world.z, z: 0 }] as const] : [])))
    placePins(layer.current, points, project, { width: 800, height: 600 })
  })

  return (
    <div className="bg-background text-foreground relative h-dvh w-full overflow-hidden">
      {/* The stand-in for the building: what the canvas would draw. */}
      <div className="absolute inset-0 bg-[radial-gradient(circle_at_40%_40%,var(--muted),var(--background))]" aria-hidden />
      <div className="relative h-[600px] w-[800px] max-w-full">
        <div ref={layer} className="pointer-events-none absolute inset-0 overflow-hidden">
          {bridge?.pinNodes}
        </div>
      </div>
      <ModelMarksPanel marks={marks} />
    </div>
  )
}

export default function ModelMarksDevPage(): JSX.Element {
  return (
    <I18nProvider initialLocale="de" fixedLocale>
      <Suspense fallback={null}>
        <Preview />
      </Suspense>
    </I18nProvider>
  )
}
