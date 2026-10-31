/**
 * Anmerkungen on the model, against MSW and the review's real hook and cards.
 *
 * The canvas is not mounted (no WebGPU here): the test plays its half of the
 * bridge, answering a capture with a viewpoint and a restore with what the
 * renderer found (`use-viewpoint-bridge.spec.tsx` holds that half). What is
 * pinned: a model's marks list as the review's own rows, „Modellansicht";
 * „Zur Ansicht springen" reads the viewpoint and hands it to the canvas, then
 * puts the cut, visibility and selection into the stage and says what this
 * model lacks; a new mark goes out through the typed client with its
 * viewpoint and no box; a link with `mark` opens that mark and its view; a pin
 * stands for each open mark and opens it.
 */

import { act, useEffect, type JSX } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import userEvent from '@testing-library/user-event'
import { http, HttpResponse } from 'msw'
import { render, screen, waitFor, within } from '@/test-utils'
import { server } from '@/mocks/server'
import { I18nProvider } from '@/i18n'
import { useChatStore } from '@/features/chat/store'
import type { AnnotationView } from '@/lib/annotations/types'
import type { ViewpointView } from '@/lib/annotations/viewpoint-types'
import { ModelMarksPanel } from '../components/model-marks-panel'
import { useModelMarks, type ModelMarks, type ModelMarksStage } from './use-model-marks'

beforeEach(() => useChatStore.setState({ currentUserId: 'user_me' }))

const WALL = '0AAAAAAAAAAAAAAAAAAAA1'
const GONE = '0AAAAAAAAAAAAAAAAAAAA9'
const MARK_ID = '3f2b8c1e-5a47-4e0b-9d6a-1c2e3f4a5b6c'

const mark = (overrides: Partial<AnnotationView> = {}): AnnotationView => ({
  id: MARK_ID,
  documentId: 'doc-model',
  number: 4,
  anchor: 'viewpoint',
  page: null,
  shape: null,
  x: null,
  y: null,
  w: null,
  h: null,
  viewpoint: { id: 'vp-1', cameraKind: 'perspective', selectionCount: 2, hasSection: true, hasSnapshot: true },
  kind: 'defect',
  body: 'Auflager fehlt',
  basis: null,
  authorKind: 'person',
  status: 'open',
  assigneeUserId: null,
  assigneeName: null,
  dueOn: null,
  revisionNumber: null,
  onCurrentRevision: true,
  createdBy: 'user_me',
  createdByName: 'Anna Berger',
  createdAt: '2026-10-29T08:00:00.000Z',
  updatedAt: '2026-10-29T08:00:00.000Z',
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
  ...overrides,
})

const VIEWPOINT: ViewpointView = {
  id: 'vp-1',
  documentId: 'doc-model',
  versionId: null,
  camera: {
    type: 'orthographic',
    position: { x: 10, y: -20, z: 5 },
    direction: { x: 0, y: 1, z: 0 },
    up: { x: 0, y: 0, z: 1 },
    viewToWorldScale: 12,
    aspectRatio: 1.5,
  },
  clippingPlanes: [{ location: { x: 0, y: 0, z: 1.2 }, direction: { x: 0, y: 0, z: 1 } }],
  components: {
    selection: { globalIds: [GONE, WALL] },
    visibility: { defaultVisibility: true, exceptions: [] },
    coloring: [],
  },
  pin: { point: { x: 1, y: 2, z: 3 }, globalId: WALL },
  hasSnapshot: true,
  createdAt: '2026-10-29T08:00:00.000Z',
}

function serve(marks: AnnotationView[]) {
  const posted: unknown[] = []
  const viewpointReads: string[] = []
  server.use(
    http.get('/api/documents/:id/annotations', () => HttpResponse.json({ annotations: marks, canAnnotate: true })),
    http.get('/api/documents/:id/annotations/:annotationId/viewpoint', ({ params }) => {
      viewpointReads.push(String(params.annotationId))
      return HttpResponse.json({ viewpoint: VIEWPOINT })
    }),
    http.post('/api/documents/:id/annotations', async ({ request }) => {
      posted.push(await request.json())
      return HttpResponse.json({ annotation: mark({ id: 'new-mark', number: 5, body: 'Stütze prüfen' }) }, { status: 201 })
    })
  )
  return { posted, viewpointReads }
}

function stage(patch: Partial<ModelMarksStage> = {}): ModelMarksStage {
  return {
    model: {
      id: 'model-1',
      documentId: 'doc-model',
      projectId: 'proj-1',
      filename: 'tragwerk.ifc',
      displayName: null,
      status: 'ready',
      schemaVersion: 'IFC4',
      elementCount: 1,
      errorMessage: null,
      summary: null,
      updatedAt: '2026-10-29T08:00:00.000Z',
    },
    modelId: 'model-1',
    elementList: [{ globalId: WALL, expressId: 21, ifcType: 'IfcWall', name: 'Wand', storeyName: 'EG' }],
    elementsLoading: false,
    view: {},
    setView: vi.fn(),
    canCollaborate: false,
    viewport: {
      camera: { view: 'iso', section: null, orthographic: false },
      visibility: { restore: vi.fn() },
      status: { phase: 'ready' },
    },
    ...patch,
  }
}

let current: ModelMarks | null = null
const marks = (): ModelMarks => {
  if (!current) throw new Error('not mounted')
  return current
}

function Harness({ stage: input }: { stage: ModelMarksStage }): JSX.Element {
  const value = useModelMarks(input)
  useEffect(() => {
    current = value
  })
  return (
    <I18nProvider initialLocale="de" fixedLocale>
      <div data-testid="pins">{value.bridge?.pinNodes}</div>
      <ModelMarksPanel marks={value} />
    </I18nProvider>
  )
}

describe('the marks on a model', () => {
  it('lists them as the review lists any mark, as a model view', async () => {
    serve([mark()])
    render(<Harness stage={stage()} />)
    act(() => marks().setOpen(true))
    const row = await screen.findByTestId('review-row')
    expect(row).toHaveTextContent('Auflager fehlt')
    expect(within(row).getByTestId('review-row-meta')).toHaveTextContent('Modellansicht')
    expect(screen.getByTestId('mark-jump')).toHaveTextContent('Zur Ansicht springen')
  })

  it('jumps to the view: the canvas gets the camera, the stage the cut, visibility and selection', async () => {
    const { viewpointReads } = serve([mark()])
    const input = stage()
    render(<Harness stage={input} />)
    act(() => marks().setOpen(true))
    await userEvent.click(await screen.findByTestId('mark-jump'))

    await waitFor(() => expect(marks().bridge?.restore?.nonce).toBe(1))
    expect(viewpointReads).toContain(MARK_ID)
    // The camera, cut and components as stored; nothing the strict wire would refuse.
    expect(marks().bridge?.restore?.viewpoint).toEqual({
      camera: VIEWPOINT.camera,
      clippingPlanes: VIEWPOINT.clippingPlanes,
      components: VIEWPOINT.components,
    })

    const visibility = { hidden: new Set<number>(), isolated: null }
    act(() =>
      marks().bridge?.onRestored({ missing: 1, section: { atMetres: 1.2, flipped: false }, visibility, selected: new Set([21]), ignoredPlanes: 0 })
    )
    expect(input.viewport.visibility.restore).toHaveBeenCalledWith(visibility)
    expect(input.setView).toHaveBeenCalledWith({
      element: WALL,
      storey: undefined,
      camera: { view: 'iso', orthographic: true, section: { atMetres: 1.2, flipped: false } },
    })
    expect(await screen.findByTestId('marks-notice')).toHaveTextContent('Ein Bauteil dieser Ansicht ist in diesem Modell nicht enthalten.')
  })

  it('sets a new mark on the captured view, through the typed client, with no box and nothing the wire refuses', async () => {
    const { posted } = serve([])
    render(<Harness stage={stage()} />)
    act(() => marks().startMark())
    expect(marks().bridge?.captureNonce).toBe(1)
    expect(await screen.findByText('Ansicht wird festgehalten …')).toBeInTheDocument()

    const viewpoint = {
      camera: VIEWPOINT.camera,
      clippingPlanes: [],
      components: { selection: { globalIds: [WALL] }, visibility: { defaultVisibility: true, exceptions: [] }, coloring: [] },
      pin: { point: { x: 1, y: 2, z: 3 }, globalId: WALL },
      snapshot: { contentType: 'image/jpeg' as const, dataBase64: 'QUFB' },
    }
    act(() => marks().bridge?.onViewpoint({ viewpoint, notices: { selectionCut: false, visibilityDropped: false, noSnapshot: false } }))

    const draft = await screen.findByTestId('review-draft')
    // The composer takes the focus the moment the capture ends.
    await waitFor(() => expect(within(draft).getByTestId('review-draft-body')).toHaveFocus())
    await userEvent.type(within(draft).getByTestId('review-draft-body'), 'Stütze prüfen{Enter}')
    await waitFor(() => expect(posted).toHaveLength(1))
    expect(posted[0]).toEqual({ kind: 'hint', body: 'Stütze prüfen', assigneeUserId: null, dueOn: null, viewpoint })
  })

  it('says what a capture could not keep', async () => {
    serve([])
    render(<Harness stage={stage()} />)
    act(() => marks().startMark())
    act(() =>
      marks().bridge?.onViewpoint({
        viewpoint: { camera: VIEWPOINT.camera, components: VIEWPOINT.components },
        notices: { selectionCut: false, visibilityDropped: true, noSnapshot: true },
      })
    )
    const notice = await screen.findByTestId('marks-notice')
    expect(notice).toHaveTextContent('sie zeigt stattdessen das ganze Modell')
    expect(notice).toHaveTextContent('ohne gesetzt')
  })

  it('opens the mark a link names at once, and its view once the model is drawn', async () => {
    const { viewpointReads } = serve([mark()])
    const loading = stage({ view: { mark: MARK_ID }, viewport: { ...stage().viewport, status: { phase: 'parsing' } } })
    const view = render(<Harness stage={loading} />)
    expect(await screen.findByTestId('review-thread')).toBeInTheDocument()
    expect(viewpointReads.filter((id) => id === MARK_ID).length).toBeLessThanOrEqual(1)
    expect(marks().bridge?.restore).toBeNull()

    view.rerender(<Harness stage={{ ...loading, viewport: { ...loading.viewport, status: { phase: 'ready' } } }} />)
    await waitFor(() => expect(marks().bridge?.restore?.nonce).toBe(1))
  })

  it('draws a pin for each open mark, which opens its thread', async () => {
    serve([mark(), mark({ id: 'closed', number: 2, status: 'resolved' })])
    render(<Harness stage={stage()} />)
    await waitFor(() => expect(marks().bridge?.pins).toEqual([{ id: MARK_ID, world: { x: 1, y: 2, z: 3 }, globalIds: [] }]))
    const pins = within(screen.getByTestId('pins')).getAllByTestId('model-pin')
    expect(pins).toHaveLength(1)
    await userEvent.click(pins[0])
    expect(await screen.findByTestId('review-thread')).toBeInTheDocument()
  })

  it('waits for the model\'s elements before it puts a view back', async () => {
    serve([mark()])
    const loading = stage({ view: { mark: MARK_ID }, elementList: [], elementsLoading: true })
    const view = render(<Harness stage={loading} />)
    expect(await screen.findByTestId('review-thread')).toBeInTheDocument()
    expect(screen.getByTestId('mark-jump')).toBeDisabled()
    await userEvent.click(screen.getByTestId('mark-jump'))
    // The pins still read the viewpoint; nothing is handed to the canvas.
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(marks().bridge?.restore).toBeNull()

    view.rerender(<Harness stage={{ ...loading, elementList: stage().elementList, elementsLoading: false }} />)
    await waitFor(() => expect(marks().bridge?.restore?.nonce).toBe(1))
    expect(screen.getByTestId('mark-jump')).toBeEnabled()
  })

  it('lets go of the no-fly-to once the selection moves off the restored element', async () => {
    serve([mark()])
    const input = stage()
    const view = render(<Harness stage={input} />)
    act(() => marks().setOpen(true))
    await userEvent.click(await screen.findByTestId('mark-jump'))
    await waitFor(() => expect(marks().bridge?.restore).not.toBeNull())
    const visibility = { hidden: new Set<number>(), isolated: null }
    act(() => marks().bridge?.onRestored({ missing: 0, section: null, visibility, selected: new Set([21]), ignoredPlanes: 0 }))
    // The stage writes the restored element into the link; the canvas must not fly to it.
    view.rerender(<Harness stage={{ ...input, view: { element: WALL } }} />)
    expect(marks().canvasOverride).toEqual({ zoomToSelection: false })
    // Another element, then the restored one again: this time it is a pick, and the canvas flies to it.
    view.rerender(<Harness stage={{ ...input, view: { element: GONE } }} />)
    await waitFor(() => expect(marks().canvasOverride).toBeNull())
    view.rerender(<Harness stage={{ ...input, view: { element: WALL } }} />)
    expect(marks().canvasOverride).toBeNull()
  })

  it('moves focus into the panel when it opens and hands it back when it closes', async () => {
    serve([mark()])
    render(
      <>
        <button type="button" data-testid="dock-button" />
        <Harness stage={stage()} />
      </>
    )
    screen.getByTestId('dock-button').focus()
    act(() => marks().setOpen(true))
    expect(screen.getByTestId('model-marks-panel')).toHaveFocus()
    act(() => marks().close())
    expect(screen.getByTestId('dock-button')).toHaveFocus()
  })
})

describe('a mark on a model and the model’s newer Fassung', () => {
  const behind = (patch: Partial<AnnotationView> = {}) =>
    mark({
      revisionNumber: 3,
      onCurrentRevision: false,
      carryTarget: { documentId: 'doc-model', documentName: 'tragwerk.ifc', revisionNumber: 4, elements: { present: 3, total: 3 } },
      ...patch,
    })

  it('says how many of its elements the new Fassung has, and carries it over through the review’s own PATCH', async () => {
    const { viewpointReads } = serve([behind()])
    const patched: unknown[] = []
    server.use(
      http.patch('/api/documents/:id/annotations/:annotationId', async ({ request }) => {
        patched.push(await request.json())
        return HttpResponse.json({ annotation: mark({ revisionNumber: 4 }) })
      })
    )
    render(<Harness stage={stage()} />)
    act(() => marks().setOpen(true))
    expect(await screen.findByTestId('mark-carry-count')).toHaveTextContent('3 von 3 Bauteilen in Fassung 4 vorhanden')
    await waitFor(() => expect(viewpointReads).toContain(MARK_ID))
    const before = viewpointReads.length

    await userEvent.click(screen.getByTestId('mark-carry-button'))
    await waitFor(() => expect(patched).toEqual([{ carryToCurrent: true, expectedStatus: 'open' }]))
    // Its view is new now: the pin reads it again.
    await waitFor(() => expect(viewpointReads.length).toBeGreaterThan(before))
    await waitFor(() => expect(screen.queryByTestId('mark-carry-count')).not.toBeInTheDocument())
  })

  it('says when none of its elements is left, and that it keeps its last view', async () => {
    serve([behind({ carryTarget: null, anchorLost: true, onCurrentRevision: true })])
    render(<Harness stage={stage()} />)
    act(() => marks().setOpen(true))
    expect(await screen.findByTestId('mark-carry-lost')).toHaveTextContent('Bauteile nicht mehr im Modell')
    expect(screen.queryByTestId('mark-carry-button')).not.toBeInTheDocument()
  })

  it('counts what is missing before anyone clicks', async () => {
    serve([behind({ carryTarget: { documentId: 'doc-model', documentName: 'tragwerk.ifc', revisionNumber: 4, elements: { present: 0, total: 2 } } })])
    render(<Harness stage={stage()} />)
    act(() => marks().setOpen(true))
    expect(await screen.findByTestId('mark-carry-count')).toHaveTextContent('Keines der 2 Bauteile in Fassung 4 vorhanden')
  })
})

describe('the model’s marks as a BCF file', () => {
  it('downloads the open ones from the export route', async () => {
    serve([mark()])
    const asked: string[] = []
    server.use(
      http.get('/api/documents/:id/annotations/bcf', ({ request }) => {
        asked.push(new URL(request.url).pathname + new URL(request.url).search)
        return new HttpResponse(new Blob(['PK']), {
          headers: { 'Content-Disposition': 'attachment; filename="Anmerkungen.bcf"' },
        })
      })
    )
    const { captureDownloads } = await import('@/test-utils/downloads')
    const downloads = captureDownloads()
    Object.assign(URL, { createObjectURL: vi.fn(() => 'blob:bcf'), revokeObjectURL: vi.fn() })
    render(<Harness stage={stage()} />)
    act(() => marks().setOpen(true))
    await userEvent.click(await screen.findByTestId('marks-export'))
    await userEvent.click(await screen.findByTestId('marks-export-open'))
    await waitFor(() => expect(asked).toEqual(['/api/documents/doc-model/annotations/bcf?scope=open']))
    await waitFor(() => expect(downloads).toEqual([{ href: 'blob:bcf', download: 'Anmerkungen.bcf' }]))
  })
})
