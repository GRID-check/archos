/**
 * @vitest-environment node
 */
/**
 * A Skizze read back and saved as a new Fassung of the same document (ADR-0148).
 *
 * The service runs for real (`bff/diagrams/sketch-document.ts`, the scene check,
 * the SVG validator, the Fassung write); what is faked is the storage under it
 * and the renderer's worker (`sketch-renderer.spec.ts` runs the real one):
 * the row, the object store and the version repository. The version repository
 * fake keeps the one rule the real one enforces under its lock, the published
 * pointer a writer read (`published-guard.ts`), so the 409 is the service's.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'

vi.mock('@/lib/auth/require-auth', () => ({
  requireAuthorizedSession: vi.fn().mockResolvedValue({
    userId: 'user-1',
    organizationId: 'org-1',
    organizationMembershipId: 'om-1',
    email: 'architektin@example.at',
    role: 'editor',
    permissions: ['project:documents:write'],
  }),
}))
vi.mock('@/i18n/server', () => ({ getLocale: vi.fn().mockResolvedValue('de') }))

const documents = new Map<string, Record<string, unknown>>()
const objects = new Map<string, string>()
const versions: Record<string, unknown>[] = []
const getAccessibleDocument = vi.fn(async (_session: unknown, id: string, _intent?: string) => {
  const row = documents.get(id)
  if (!row) throw Object.assign(new Error('Not found'), { status: 404 })
  return row
})
vi.mock('@/lib/documents/access', () => ({
  getAccessibleDocument: (...a: [unknown, string, string?]) => getAccessibleDocument(...a),
}))
vi.mock('@/lib/s3', () => ({
  s3Client: {
    send: vi.fn(async (command: { constructor: { name: string }; input: { Key: string; Body?: Uint8Array } }) => {
      if (command.constructor.name === 'PutObjectCommand') {
        objects.set(command.input.Key, new TextDecoder().decode(command.input.Body))
        return {}
      }
      const text = objects.get(command.input.Key)
      if (text === undefined) throw new Error('NoSuchKey')
      return { Body: { transformToString: async () => text } }
    }),
  },
}))
vi.mock('@/lib/storage/bucket', () => ({ resolveDocumentBucket: () => 'bucket' }))
const recordDocumentAccess = vi.fn()
vi.mock('@/lib/download-log/service', () => ({ recordDocumentAccess: (...a: unknown[]) => recordDocumentAccess(...a) }))
const roomEvents: Array<{ documentId: string; event: Record<string, unknown> }> = []
vi.mock('@/lib/realtime/document-channel', () => ({
  publishToDocumentRoom: vi.fn(async (documentId: string, event: Record<string, unknown>) => {
    roomEvents.push({ documentId, event })
  }),
}))
vi.mock('@/lib/documents/repository', () => ({
  findDocumentAuthoredByRef: vi.fn(async (_ref: string, _org: string, _project: string, producer: string) =>
    producer === 'diagram_pdf' && documents.has('doc-pdf')
      ? { id: 'doc-pdf', filename: 'x.pdf', folderId: (documents.get('doc-pdf')!.folderId as string | null) ?? null }
      : null
  ),
}))
vi.mock('@/lib/projects/repository', () => ({ findProjectInOrg: vi.fn(async () => ({ name: 'Wohnhaus Hietzing' })) }))
vi.mock('@/lib/documents/generated', async () => {
  const { aiProvenanceMarking } = await import('@/lib/ai-provenance')
  const { isPersonSketchRef } = await import('@/lib/documents/document-authors')
  // The run id aside, the real rule: a person-started Skizze is `AIGenerated=false` until an agent drew on it.
  return {
    generatedDocumentMarking: (_producer: string, ref: string, options: { aiAssisted?: boolean } = {}) =>
      aiProvenanceMarking(isPersonSketchRef(ref) && !options.aiAssisted ? { byPerson: true } : {}),
  }
})
const renderDiagramPdf = vi.fn(async (input: { provenance: string }) => new TextEncoder().encode(`%PDF ${input.provenance}`))
vi.mock('@/lib/diagrams/svg-to-pdf', () => ({
  renderDiagramPdf: (...a: [{ provenance: string }]) => renderDiagramPdf(...a),
}))
const draftGate = vi.hoisted(() => ({ received: true, generate: true }))
vi.mock('@/lib/documents/version-content', () => ({
  mayReceiveVersionBytes: async () => draftGate.received,
  newVersionWriteId: () => 'w1',
  resolveVersionBucket: async () => 'bucket',
  versionWriteKey: (key: string, n: number, id: string) => `${key}/v${n}/${id}`,
}))
vi.mock('@/lib/authz/projects', async () => {
  const { ForbiddenError } = await import('@/lib/api/errors')
  return {
    requireProjectAccess: vi.fn(async (_session: unknown, _project: string, permission: string | string[]) => {
      if (permission === 'project:documents:generate' && !draftGate.generate) throw new ForbiddenError('no generate')
    }),
  }
})
vi.mock('@/lib/documents/version-repository', async () => {
  const { PublishedVersionMovedError } = await import('@/lib/documents/published-guard')
  return {
    listDocumentVersions: vi.fn(async (id: string) => versions.filter((v) => v.documentId === id)),
    nextVersionNumber: vi.fn(async (id: string) => versions.filter((v) => v.documentId === id).length + 1),
    insertPublishedVersion: vi.fn(
      async (values: Record<string, unknown>, expected?: { publishedVersionId: string | null; of?: string }) => {
        const row = documents.get(values.documentId as string)!
        const checked = documents.get(expected?.of ?? (values.documentId as string))!
        if (expected && expected.publishedVersionId !== checked.publishedVersionId) {
          throw new PublishedVersionMovedError(checked.id as string, checked.publishedVersionId as string | null)
        }
        const mine = versions.filter((v) => v.documentId === values.documentId)
        const superseded = mine.filter((v) => v.state === 'published')
        for (const old of superseded) old.state = 'superseded'
        const version = { ...values, id: `${values.documentId}-v${mine.length + 1}`, versionNumber: mine.length + 1 }
        versions.push(version)
        Object.assign(row, { publishedVersionId: version.id, storageKey: values.storageKey })
        return { version, superseded, carried: { moved: [], lost: [] } }
      }
    ),
  }
})
// A save into an open Freigabe draft goes through the lifecycle's content replacement; its swap is the lifecycle's spec.
const replaceVersionContent = vi.fn(
  async (_session: unknown, _documentId: string, versionId: string, rendered: { bytes: Buffer; contentHash: string }) => {
    const draft = versions.find((v) => v.id === versionId)!
    objects.set(`draft/${versionId}`, rendered.bytes.toString('utf8'))
    return Object.assign(draft, { storageKey: `draft/${versionId}`, contentHash: rendered.contentHash })
  }
)
vi.mock('@/lib/documents/lifecycle', () => ({
  replaceVersionContent: (...a: Parameters<typeof replaceVersionContent>) => replaceVersionContent(...a),
}))
const folderRestrictsReading = vi.fn(async (_org: string, _project: string | null, folderId: string | null) => folderId === 'folder-restricted')
vi.mock('@/lib/conversations/restricted-egress', () => ({
  folderRestrictsReading: (...a: [string, string | null, string | null]) => folderRestrictsReading(...a),
}))
const announceNewRevision = vi.fn(async () => {})
vi.mock('@/lib/documents/revision-notify', () => ({ announceNewRevision: (...a: unknown[]) => announceNewRevision(...(a as [])) }))
const recordAuditEvent = vi.fn()
vi.mock('@/lib/audit/service', () => ({ recordAuditEvent: (...a: unknown[]) => recordAuditEvent(...a) }))
vi.mock('@/lib/events/bus', () => ({ publishToUsers: vi.fn() }))
vi.mock('@/lib/documents/shelf-live', () => ({ publishShelfChanged: vi.fn() }))
vi.mock('@/lib/storage/service', () => ({ assertWithinStorageQuota: vi.fn() }))
const discardObject = vi.fn()
vi.mock('@/lib/storage/discard', () => ({ discardObject: (...a: unknown[]) => discardObject(...a) }))
const recordSketchRevisedScore = vi.fn()
const recordSketchSaveScore = vi.fn()
vi.mock('@/lib/langfuse/sketch-score', () => ({
  recordSketchRevisedScore: (...a: unknown[]) => recordSketchRevisedScore(...a),
  recordSketchSaveScore: (...a: unknown[]) => recordSketchSaveScore(...a),
  recordSketchPinsKeptScore: vi.fn(async () => {}),
}))

const upsertSearchFacets = vi.fn(async (_org: string, rows: readonly unknown[]) => rows.length)
vi.mock('@/lib/search/facets-repository', () => ({ upsertSearchFacets: (...a: [string, readonly unknown[]]) => upsertSearchFacets(...a) }))

/** The server's drawing: a picture of its own, so a test can tell it from anything a client sent. */
const SERVER_PICTURE = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 120 60"><circle cx="30" cy="30" r="20"/></svg>'
const render = vi.fn(async (input: { elements: readonly Record<string, unknown>[]; remeasure: readonly string[] }) => ({
  svg: SERVER_PICTURE,
  remeasured: input.remeasure.map((id) => ({ id, width: 77, height: 25 })),
  ms: 12,
}))
vi.mock('@/lib/diagrams/sketch-renderer', async () => {
  const actual = await vi.importActual<typeof import('@/lib/diagrams/sketch-renderer')>('@/lib/diagrams/sketch-renderer')
  return { ...actual, sketchRenderer: () => ({ render: (...a: Parameters<typeof render>) => render(...a), close: async () => {} }) }
})

import { createInProcessStore, setLimitStore } from '@/lib/limits'
import { diagramsCopy } from '@/i18n/namespaces/diagrams'
import { acceptDiagram } from '@/lib/diagrams/svg'
import { storedDiagramSource } from '@/lib/diagrams/stored-source'
import { sceneHashOf } from '@/lib/diagrams/sketch-scene'
import { ROOM_PEER_HEADER } from '@/lib/diagrams/sketch-wire'
import { GET, PUT } from './route'

const PICTURE = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 50"><rect width="40" height="20"/></svg>'
const SCENE = {
  type: 'excalidraw',
  elements: [
    { id: 'room', type: 'rectangle', x: 0, y: 0 },
    { id: 'room-label', type: 'text', x: 2, y: 2, text: 'Küche', containerId: 'room' },
  ],
  appState: {},
  files: {},
}

function fileSketch(id: string, producer: string, source: string, contentType = 'image/svg+xml') {
  const stored = acceptDiagram({ svg: PICTURE, source, sourceKind: 'excalidraw' }, { notice: 'n', provenance: 'AIGenerated=true' }).svg
  objects.set(`doc/${id}/file`, stored)
  documents.set(id, {
    id,
    organizationId: 'org-1',
    projectId: 'proj-1',
    folderId: null,
    filename: `${id}.svg`,
    displayName: 'Raumprogramm.svg',
    storageKey: `doc/${id}/file`,
    storageBucket: null,
    contentType,
    fileSize: stored.length,
    contentHash: 'sha256:filed',
    createdBy: 'user-0',
    createdAt: new Date('2026-10-01T00:00:00Z'),
    authoredBy: 'agent',
    authoredByProducer: producer,
    authoredByRef: 'msg_42-1a2b3c4d',
    publishedVersionId: null,
  })
}

const call = (method: 'GET' | 'PUT', id: string, body?: unknown, { query = '', headers = {} }: { query?: string; headers?: Record<string, string> } = {}) =>
  (method === 'GET' ? GET : PUT)(
    new NextRequest(`https://grid.test/api/documents/${id}/sketch${query}`, {
      method,
      headers: { 'Content-Type': 'application/json', ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
    { params: Promise.resolve({ id }) }
  )

/** The scene the latest Fassung of a document stores. */
function storedScene(id: string): { elements: Array<Record<string, unknown>>; appState?: Record<string, unknown> } {
  const key = documents.get(id)!.storageKey as string
  return JSON.parse(storedDiagramSource(objects.get(key)!)!.source)
}

beforeEach(() => {
  setLimitStore(createInProcessStore())
  documents.clear()
  objects.clear()
  versions.length = 0
  recordAuditEvent.mockReset()
  discardObject.mockReset()
  recordSketchRevisedScore.mockReset()
  recordSketchSaveScore.mockReset()
  recordDocumentAccess.mockReset()
  render.mockClear()
  upsertSearchFacets.mockClear()
  roomEvents.length = 0
  renderDiagramPdf.mockClear()
  replaceVersionContent.mockClear()
  announceNewRevision.mockClear()
  fileSketch('doc-svg', 'diagram_svg', JSON.stringify(SCENE))
  documents.set('doc-pdf', { ...documents.get('doc-svg'), id: 'doc-pdf', contentType: 'application/pdf', storageKey: 'doc/doc-pdf/file', authoredByProducer: 'diagram_pdf' })
})

describe('GET /api/documents/[id]/sketch', () => {
  it('answers the stored scene and its outline, and the Fassung it was read from', async () => {
    const response = await call('GET', 'doc-svg')
    expect(response.status).toBe(200)
    const body = await response.json()
    expect(body).toMatchObject({ documentId: 'doc-svg', versionId: null, title: 'Raumprogramm', scene: { type: 'excalidraw' } })
    expect(body.outline.shapes).toEqual([{ id: 'room', type: 'rectangle', label: 'Küche', box: { x: 0, y: 0, w: 0, h: 0 } }])
    expect(body.canWrite).toBe(true)
    // The outline comes first: a reader cut off at a size limit still has it.
    expect(Object.keys(body).indexOf('outline')).toBeLessThan(Object.keys(body).indexOf('scene'))
  })

  it('leaves the scene out on ?scene=omit, and answers only the named elements on ?ids=', async () => {
    const outlineOnly = await (await call('GET', 'doc-svg', undefined, { query: '?scene=omit' })).json()
    expect(outlineOnly.scene).toBeUndefined()
    expect(outlineOnly.outline.texts).toHaveLength(1)
    const focused = await (await call('GET', 'doc-svg', undefined, { query: '?ids=room-label,missing' })).json()
    expect(focused.scene).toBeUndefined()
    expect(focused.elements).toEqual([SCENE.elements[1]])
    expect((await call('GET', 'doc-svg', undefined, { query: '?scene=all' })).status).toBe(400)
  })

  it('tells a reader who may not write that the editor only shows', async () => {
    const { ForbiddenError } = await import('@/lib/api/errors')
    const readOnly = async (_session: unknown, id: string, intent?: string) => {
      if (intent === 'write') throw new ForbiddenError()
      return documents.get(id) as Record<string, unknown>
    }
    getAccessibleDocument.mockImplementationOnce(readOnly).mockImplementationOnce(readOnly)
    const response = await call('GET', 'doc-svg')
    expect(response.status).toBe(200)
    expect((await response.json()).canWrite).toBe(false)
  })

  it('answers 415 for a document without a scene', async () => {
    fileSketch('doc-mermaid', 'diagram_svg', 'graph TD; A-->B')
    expect((await call('GET', 'doc-mermaid')).status).toBe(415)
    expect((await call('GET', 'doc-pdf')).status).toBe(415)
  })
})

describe('PUT /api/documents/[id]/sketch', () => {
  const edited = { ...SCENE, elements: [...SCENE.elements, { id: 'lift', type: 'diamond', x: 90, y: 0 }] }

  it('writes a new Fassung of the same document, keeps the filed bytes as Fassung 1, and redraws the PDF', async () => {
    const response = await call('PUT', 'doc-svg', { scene: edited, baseVersionId: null })
    expect(response.status).toBe(200)
    const body = await response.json()
    expect(body).toEqual({
      documentId: 'doc-svg',
      versionId: 'doc-svg-v2',
      versionNumber: 2,
      state: 'published',
      contentHash: expect.stringMatching(/^sha256:/),
      pdf: { documentId: 'doc-pdf', versionId: 'doc-pdf-v2' },
      pdfStale: false,
    })
    // No new document: both rows are the ones that were filed, each with a history.
    expect([...documents.keys()]).toEqual(['doc-svg', 'doc-pdf'])
    const svgHistory = versions.filter((v) => v.documentId === 'doc-svg')
    expect(svgHistory.map((v) => [v.versionNumber, v.state, v.storageKey])).toEqual([
      [1, 'superseded', 'doc/doc-svg/file'],
      [2, 'published', 'doc/doc-svg/file/v2/w1'],
    ])
    const stored = objects.get('doc/doc-svg/file/v2/w1')!
    expect(stored).toContain('"id":"lift"')
    expect(stored).toContain(diagramsCopy.messages.de.markingEdited.slice(0, 30))
    expect(recordAuditEvent).toHaveBeenCalledWith(expect.objectContaining({ action: 'document.version.published' }))
    expect(recordSketchRevisedScore).toHaveBeenCalledWith({
      organizationId: 'org-1',
      documentId: 'doc-svg',
      answerRef: 'msg_42-1a2b3c4d',
      versionNumber: 2,
    })
  })

  // S6 review, finding 5: a person started this Skizze on a page; its files said „KI-generiert“ and „Von Piloti entworfen“.
  it('files a person-started Skizze as a person’s drawing, in its line, its machine marking and its PDF', async () => {
    for (const id of ['doc-svg', 'doc-pdf']) documents.set(id, { ...documents.get(id), authoredByRef: 'person-sketch-6f1c0d1e-0000-4000-8000-000000000001' })
    objects.set('doc/doc-svg/file', objects.get('doc/doc-svg/file')!.replace('AIGenerated=true', 'AIGenerated=false'))
    const response = await call('PUT', 'doc-svg', { scene: edited, baseVersionId: null })
    expect(response.status).toBe(200)
    const stored = objects.get('doc/doc-svg/file/v2/w1')!
    expect(stored).toContain(diagramsCopy.messages.de.markingPerson.slice(0, 40))
    expect(stored).not.toContain(diagramsCopy.messages.de.markingEdited.slice(0, 30))
    expect(stored).toContain('AIGenerated=false')
    expect(stored).not.toContain('AIGenerated=true')
    expect(renderDiagramPdf).toHaveBeenLastCalledWith(expect.objectContaining({ provenance: 'AIGenerated=false' }))
  })

  it('keeps a person-started Skizze AI-assisted once an agent drew on it, from its stored bytes', async () => {
    for (const id of ['doc-svg', 'doc-pdf']) documents.set(id, { ...documents.get(id), authoredByRef: 'person-sketch-6f1c0d1e-0000-4000-8000-000000000001' })
    expect((await call('PUT', 'doc-svg', { scene: edited, baseVersionId: null })).status).toBe(200)
    const stored = objects.get('doc/doc-svg/file/v2/w1')!
    expect(stored).toContain('weitergeführt — KI-unterstützt')
    expect(stored).toContain('AIGenerated=true')
  })

  it('refuses a stale base Fassung with 409 and the current one, and keeps no bytes for it', async () => {
    await call('PUT', 'doc-svg', { scene: edited, baseVersionId: null })
    const response = await call('PUT', 'doc-svg', { scene: SCENE, baseVersionId: 'doc-svg-v1' })
    expect(response.status).toBe(409)
    expect(await response.json()).toMatchObject({ details: { reason: 'stale_base_version', currentVersionId: 'doc-svg-v2' } })
    expect(discardObject).toHaveBeenCalled()
    expect(versions.filter((v) => v.documentId === 'doc-svg')).toHaveLength(2)
  })

  it('answers 415 for a document without a scene, and 400 for a scene with an image', async () => {
    expect((await call('PUT', 'doc-pdf', { scene: SCENE, baseVersionId: null })).status).toBe(415)
    const withImage = { ...SCENE, elements: [{ id: 'img', type: 'image', x: 0, y: 0 }] }
    const response = await call('PUT', 'doc-svg', { scene: withImage, baseVersionId: null })
    expect(response.status).toBe(400)
    expect(versions).toHaveLength(0)
  })

  it('stores the picture the server drew from the scene, never one a client sent', async () => {
    const response = await call('PUT', 'doc-svg', { scene: edited, svg: '<svg><script/></svg>', baseVersionId: null })
    expect(response.status).toBe(200)
    const stored = objects.get('doc/doc-svg/file/v2/w1')!
    expect(stored).toContain('<circle')
    expect(stored).not.toContain('script')
    expect(render.mock.calls[0][0].elements.map((element) => element.id)).toEqual(['room', 'room-label', 'lift'])
    // The PDF is drawn from the same picture.
    expect(renderDiagramPdf.mock.calls[0][0]).toMatchObject({ viewport: { width: 120, height: 60 } })
  })

  it('writes the sketch’s search row from the saved scene, so its labels are found', async () => {
    await call('PUT', 'doc-svg', { scene: { ...edited, elements: [...edited.elements, { id: 'lift-label', type: 'text', x: 92, y: 2, text: 'Lift', containerId: 'lift' }] }, baseVersionId: null })
    expect(upsertSearchFacets).toHaveBeenCalledTimes(1)
    const [org, [row]] = upsertSearchFacets.mock.calls[0] as [string, [{ documentId: string; searchText: string }]]
    expect(org).toBe('org-1')
    expect(row).toMatchObject({ documentId: 'doc-svg', searchText: 'Raumprogramm · Küche · Lift' })
  })

  it('lays out again only the texts a save added or changed, and stores their new size', async () => {
    const relabelled = {
      ...SCENE,
      elements: [SCENE.elements[0], { ...SCENE.elements[1], text: 'Küche und Essen' }, { id: 'note', type: 'text', x: 0, y: 90, text: 'Süden', width: 1 }],
    }
    await call('PUT', 'doc-svg', { scene: relabelled, baseVersionId: null })
    expect(render.mock.calls[0][0].remeasure).toEqual(['room-label', 'note'])
    const note = storedScene('doc-svg').elements.find((element) => element.id === 'note')!
    expect(note).toMatchObject({ width: 77, height: 25, text: 'Süden' })
  })

  it('answers 503 when the picture cannot be drawn, scores it, and saves nothing', async () => {
    const { SketchRenderError } = await import('@/lib/diagrams/sketch-renderer')
    render.mockRejectedValueOnce(new SketchRenderError('timeout'))
    const response = await call('PUT', 'doc-svg', { scene: edited, baseVersionId: null })
    expect(response.status).toBe(503)
    expect((await response.json()).details).toMatchObject({ reason: 'timeout' })
    expect(versions).toHaveLength(0)
    expect(recordSketchSaveScore).toHaveBeenCalledWith(expect.objectContaining({ outcome: 'render_failed', refusal: 'timeout' }))
  })

  it('reads a chunked body only up to the cap: no declared length is no way past it', async () => {
    const huge = new TextEncoder().encode(JSON.stringify({ scene: SCENE, svg: 'x'.repeat(4 * 1024 * 1024), baseVersionId: null }))
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        for (let at = 0; at < huge.length; at += 64 * 1024) controller.enqueue(huge.slice(at, at + 64 * 1024))
        controller.close()
      },
    })
    const init = { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body, duplex: 'half' }
    const request = new NextRequest('https://grid.test/api/documents/doc-svg/sketch', init as ConstructorParameters<typeof NextRequest>[1])
    expect(request.headers.get('content-length')).toBeNull()
    const response = await PUT(request, { params: Promise.resolve({ id: 'doc-svg' }) })
    expect(response.status).toBe(413)
    expect(versions).toHaveLength(0)
  })

  it('versions a save that kept the versions it read, and keeps what it left out as deleted, so open canvases merge it', async () => {
    // As an agent writes it: the label changed at the version it read, and the lift is simply gone.
    await call('PUT', 'doc-svg', {
      scene: { ...SCENE, elements: [{ ...SCENE.elements[0], version: 3, versionNonce: 5 }, { ...SCENE.elements[1], version: 3, versionNonce: 6 }, { id: 'lift', type: 'diamond', x: 90, y: 0, version: 2, versionNonce: 7 }] },
      baseVersionId: null,
    })
    const response = await call('PUT', 'doc-svg', {
      scene: { ...SCENE, elements: [{ ...SCENE.elements[0], version: 3, versionNonce: 5 }, { ...SCENE.elements[1], text: 'Speis', version: 3, versionNonce: 6 }] },
      baseVersionId: 'doc-svg-v2',
    })
    expect(response.status).toBe(200)
    const byId = Object.fromEntries(storedScene('doc-svg').elements.map((element) => [element.id, element]))
    expect(byId.room).toMatchObject({ version: 3, versionNonce: 5 })
    expect(byId['room-label']).toMatchObject({ text: 'Speis', version: 4 })
    expect(byId['room-label'].versionNonce).not.toBe(6)
    expect(byId.lift).toMatchObject({ isDeleted: true, version: 3 })
  })

  it('tells the document room of the Fassung, stamped with the saving tab so it hears no echo', async () => {
    await call('PUT', 'doc-svg', { scene: edited, baseVersionId: null }, { headers: { [ROOM_PEER_HEADER]: 'peer_anna0001' } })
    const saved = roomEvents.filter(({ event }) => event.kind === 'scene.saved')
    expect(saved).toHaveLength(1)
    const [{ documentId, event }] = saved
    expect(documentId).toBe('doc-svg')
    expect(event).toMatchObject({ kind: 'scene.saved', versionId: 'doc-svg-v2', peer: { peerId: 'peer_anna0001', userId: 'user-1', kind: 'person' } })
    expect(event.sceneHash).toBe(sceneHashOf(storedScene('doc-svg').elements))
    // A save without a tab (an agent through MCP) is told under a peer of its own.
    await call('PUT', 'doc-svg', { scene: SCENE, baseVersionId: 'doc-svg-v2' })
    const second = roomEvents.filter(({ event }) => event.kind === 'scene.saved')[1]
    expect((second.event.peer as { peerId: string }).peerId).toMatch(/^save_[0-9a-f]{12}$/)
    // Every Fassung made current is told as such, the PDF's in its own room too (`lib/documents/current-version.ts`).
    expect(roomEvents.filter(({ event }) => event.kind === 'version.published').map(({ documentId: id }) => id)).toEqual([
      'doc-svg',
      'doc-pdf',
      'doc-svg',
      'doc-pdf',
    ])
  })

  it('drops an element link, customData outside the allow-list and appState Excalidraw does not export', async () => {
    const planted = {
      ...SCENE,
      elements: [{ ...SCENE.elements[0], link: 'https://evil.example', customData: { tracker: 1 } }, SCENE.elements[1]],
      appState: { viewBackgroundColor: '#fff', gridSize: 20, theme: 'dark', openDialog: { name: 'ttd' } },
    }
    expect((await call('PUT', 'doc-svg', { scene: planted, baseVersionId: null })).status).toBe(200)
    const scene = storedScene('doc-svg')
    expect(scene.elements[0]).not.toHaveProperty('link')
    expect(scene.elements[0]).not.toHaveProperty('customData')
    expect(scene.appState).toEqual({ viewBackgroundColor: '#fff', gridSize: 20 })
  })

  it('draws no PDF from a drawing a newer save already replaced, and says when the PDF could not be drawn', async () => {
    // A second save commits its SVG while this one renders the PDF.
    renderDiagramPdf.mockImplementationOnce(async (input) => {
      documents.get('doc-svg')!.publishedVersionId = 'doc-svg-newer'
      return new TextEncoder().encode(`%PDF ${input.provenance}`)
    })
    const superseded = await (await call('PUT', 'doc-svg', { scene: edited, baseVersionId: null })).json()
    expect(superseded).toMatchObject({ pdf: null, pdfStale: false })
    // The filed PDF is recorded as Fassung 1, as on every first save; nothing was drawn over it.
    expect(versions.filter((v) => v.documentId === 'doc-pdf').map((v) => v.storageKey)).toEqual(['doc/doc-pdf/file'])

    documents.get('doc-svg')!.publishedVersionId = 'doc-svg-v2'
    renderDiagramPdf.mockRejectedValueOnce(new Error('font missing'))
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const failed = await (await call('PUT', 'doc-svg', { scene: SCENE, baseVersionId: 'doc-svg-v2' })).json()
    expect(failed).toMatchObject({ pdf: null, pdfStale: true })
    expect(recordSketchSaveScore).toHaveBeenLastCalledWith(expect.objectContaining({ outcome: 'pdf_stale', metadata: expect.objectContaining({ pdf: 'failed' }) }))
  })

  it('answers a committed Fassung as saved even when its audit write fails', async () => {
    recordAuditEvent.mockRejectedValueOnce(new Error('audit down'))
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const response = await call('PUT', 'doc-svg', { scene: edited, baseVersionId: null })
    expect(response.status).toBe(200)
    expect((await response.json()).versionNumber).toBe(2)
  })

  it('scores every attempt: saved, a conflict and a refusal', async () => {
    await call('PUT', 'doc-svg', { scene: edited, baseVersionId: null })
    await call('PUT', 'doc-svg', { scene: SCENE, baseVersionId: 'doc-svg-v1' })
    await call('PUT', 'doc-svg', { scene: { ...SCENE, elements: [{ id: 'img', type: 'image', x: 0, y: 0 }] }, baseVersionId: 'doc-svg-v2' })
    expect(recordSketchSaveScore.mock.calls.map(([input]) => [input.outcome, input.refusal])).toEqual([
      ['saved', undefined],
      ['conflict', undefined],
      ['refused', 'unsupported-element'],
    ])
    expect(recordSketchSaveScore.mock.calls[0][0]).toMatchObject({ answerRef: 'msg_42-1a2b3c4d', documentId: 'doc-svg' })
  })
})

describe('GET, what it promises and what it logs', () => {
  it('promises no editing of a sketch the PUT would not take', async () => {
    documents.get('doc-svg')!.authoredByProducer = 'upload'
    expect((await (await call('GET', 'doc-svg')).json()).canWrite).toBe(false)
  })

  it('logs a read, but not the preview’s probe, which carries nothing of the drawing (C6)', async () => {
    const probe = await (await call('GET', 'doc-svg', undefined, { query: '?probe=1' })).json()
    expect(probe).toEqual({ hasScene: true, canWrite: true, versionId: null })
    expect(recordDocumentAccess).not.toHaveBeenCalled()
    await call('GET', 'doc-svg')
    expect(recordDocumentAccess).toHaveBeenCalledTimes(1)
  })

  it('probes a document without a scene as having none, instead of handing anything over', async () => {
    fileSketch('doc-mermaid', 'diagram_svg', 'flowchart LR\n  A --> B')
    expect(await (await call('GET', 'doc-mermaid', undefined, { query: '?probe=1' })).json()).toEqual({
      hasScene: false,
      canWrite: false,
      versionId: null,
    })
  })
})

describe('a save and the Freigabe round (C2, C4)', () => {
  const edited = { ...SCENE, elements: [...SCENE.elements, { id: 'stair', type: 'rectangle', x: 60, y: 0 }] }
  const openDraft = (state: string) => {
    versions.push({ documentId: 'doc-svg', id: 'doc-svg-d', state, versionNumber: 2, storageKey: 'doc/doc-svg/file', contentHash: 'sha256:filed' })
  }

  it('refuses a save while a version is in review, naming why, and writes nothing', async () => {
    openDraft('in_review')
    const response = await call('PUT', 'doc-svg', { scene: edited, baseVersionId: null })
    expect(response.status).toBe(409)
    expect((await response.json()).details).toMatchObject({ reason: 'review_open', versionId: 'doc-svg-d' })
    expect(versions.filter((v) => v.state === 'published')).toHaveLength(0)
    expect(renderDiagramPdf).not.toHaveBeenCalled()
    expect(recordSketchSaveScore).toHaveBeenLastCalledWith(expect.objectContaining({ outcome: 'review_open' }))
  })

  it('opens the open draft for a writer, and saves into it: nothing published, no PDF drawn', async () => {
    openDraft('changes_requested')
    const view = await (await call('GET', 'doc-svg')).json()
    expect(view).toMatchObject({ versionId: 'doc-svg-d', saveTarget: 'draft', contentHash: 'sha256:filed' })
    const response = await call('PUT', 'doc-svg', { scene: edited, baseVersionId: 'doc-svg-d', baseContentHash: 'sha256:filed' })
    expect(response.status).toBe(200)
    const saved = await response.json()
    expect(saved).toMatchObject({ versionId: 'doc-svg-d', state: 'draft', pdf: null, pdfStale: false })
    expect(replaceVersionContent).toHaveBeenCalledWith(expect.anything(), 'doc-svg', 'doc-svg-d', expect.objectContaining({ contentType: 'image/svg+xml' }), 'sha256:filed', expect.anything())
    expect(storedDiagramSource(objects.get('draft/doc-svg-d')!)!.source).toContain('stair')
    expect(versions.filter((v) => v.state === 'published')).toHaveLength(0)
    expect(renderDiagramPdf).not.toHaveBeenCalled()
    expect(roomEvents.map(({ event }) => event.kind)).toEqual(['scene.saved'])
    expect(recordSketchSaveScore).toHaveBeenLastCalledWith(expect.objectContaining({ outcome: 'drafted' }))
    // A save from the published Fassung, or from an older state of the draft, merges first.
    expect((await call('PUT', 'doc-svg', { scene: edited, baseVersionId: null })).status).toBe(409)
    expect((await call('PUT', 'doc-svg', { scene: edited, baseVersionId: 'doc-svg-d', baseContentHash: 'sha256:filed' })).status).toBe(409)
  })

  // The coherence review's findings 3 and 4: the editor offered a save the draft write refuses, and read a draft's bytes past the hold.
  it('opens a draft to watch for a writer who may not write into it (no project:documents:generate)', async () => {
    openDraft('draft')
    draftGate.generate = false
    try {
      const view = await (await call('GET', 'doc-svg')).json()
      expect(view).toMatchObject({ canWrite: false, saveTarget: 'draft' })
      expect((await (await call('GET', 'doc-svg', undefined, { query: '?probe=1' })).json()).canWrite).toBe(false)
    } finally {
      draftGate.generate = true
    }
  })

  it('reads no draft bytes this session may not receive: the current Fassung, to watch, and a save is refused', async () => {
    openDraft('draft')
    draftGate.received = false
    const written = vi.mocked(replaceVersionContent).mock.calls.length
    try {
      const view = await (await call('GET', 'doc-svg')).json()
      expect(view).toMatchObject({ canWrite: false, versionId: expect.not.stringMatching(/^doc-svg-d$/), contentHash: null })
      const response = await call('PUT', 'doc-svg', { scene: edited, baseVersionId: 'doc-svg-d', baseContentHash: 'sha256:filed' })
      expect(response.status).toBe(404)
      expect(vi.mocked(replaceVersionContent).mock.calls.length).toBe(written)
    } finally {
      draftGate.received = true
    }
  })

  it('tells the followers once when a save leaves a Fassung released through Freigabe, and stays silent otherwise', async () => {
    await call('PUT', 'doc-svg', { scene: edited, baseVersionId: null })
    expect(announceNewRevision).not.toHaveBeenCalled()
    versions.find((v) => v.id === 'doc-svg-v2')!.approvedBy = 'user-chief'
    await call('PUT', 'doc-svg', { scene: SCENE, baseVersionId: 'doc-svg-v2' })
    expect(announceNewRevision).toHaveBeenCalledTimes(1)
    expect(announceNewRevision).toHaveBeenCalledWith(expect.objectContaining({ newerId: 'doc-svg', versionId: 'doc-svg-v3' }))
  })
})

describe('the PDF is the Skizze’s rendition (C3)', () => {
  const edited = { ...SCENE, elements: [...SCENE.elements, { id: 'safe', type: 'rectangle', x: 90, y: 0 }] }

  it('draws no new drawing into a PDF that sits wider than the Skizze’s restricted folder', async () => {
    documents.get('doc-svg')!.folderId = 'folder-restricted'
    documents.get('doc-pdf')!.folderId = null
    const response = await call('PUT', 'doc-svg', { scene: edited, baseVersionId: null })
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ pdf: null, pdfStale: false })
    expect(renderDiagramPdf).not.toHaveBeenCalled()
    expect(recordSketchSaveScore).toHaveBeenLastCalledWith(expect.objectContaining({ metadata: expect.objectContaining({ pdf: 'confined' }) }))
  })

  it('draws it when both sit in the same restricted folder', async () => {
    documents.get('doc-svg')!.folderId = 'folder-restricted'
    documents.get('doc-pdf')!.folderId = 'folder-restricted'
    expect((await (await call('PUT', 'doc-svg', { scene: edited, baseVersionId: null })).json()).pdf).toEqual({
      documentId: 'doc-pdf',
      versionId: 'doc-pdf-v2',
    })
  })
})
