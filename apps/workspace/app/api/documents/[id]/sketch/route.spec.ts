/**
 * @vitest-environment node
 */
/**
 * A Skizze read back and saved as a new Fassung of the same document (ADR-0148).
 *
 * The service runs for real (`bff/diagrams/sketch-document.ts`, the scene check,
 * the SVG validator, the Fassung write); what is faked is the storage under it:
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
    producer === 'diagram_pdf' && documents.has('doc-pdf') ? { id: 'doc-pdf', filename: 'x.pdf', folderId: null } : null
  ),
}))
vi.mock('@/lib/projects/repository', () => ({ findProjectInOrg: vi.fn(async () => ({ name: 'Wohnhaus Hietzing' })) }))
vi.mock('@/lib/documents/generated', async () => {
  const { aiProvenanceMarking } = await import('@/lib/ai-provenance')
  return { generatedDocumentMarking: () => aiProvenanceMarking({}) }
})
const renderDiagramPdf = vi.fn(async (input: { provenance: string }) => new TextEncoder().encode(`%PDF ${input.provenance}`))
vi.mock('@/lib/diagrams/svg-to-pdf', () => ({
  renderDiagramPdf: (...a: [{ provenance: string }]) => renderDiagramPdf(...a),
}))
vi.mock('@/lib/documents/version-content', () => ({
  newVersionWriteId: () => 'w1',
  resolveVersionBucket: async () => 'bucket',
  versionWriteKey: (key: string, n: number, id: string) => `${key}/v${n}/${id}`,
}))
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
        return { version, superseded }
      }
    ),
  }
})
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
}))

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
  roomEvents.length = 0
  renderDiagramPdf.mockClear()
  fileSketch('doc-svg', 'diagram_svg', JSON.stringify(SCENE))
  documents.set('doc-pdf', { ...documents.get('doc-svg'), id: 'doc-pdf', contentType: 'application/pdf', storageKey: 'doc/doc-pdf/file', authoredByProducer: 'diagram_pdf' })
})

describe('GET /api/documents/[id]/sketch', () => {
  it('answers the stored scene and its outline, and the Fassung it was read from', async () => {
    const response = await call('GET', 'doc-svg')
    expect(response.status).toBe(200)
    const body = await response.json()
    expect(body).toMatchObject({ documentId: 'doc-svg', versionId: null, title: 'Raumprogramm', scene: { type: 'excalidraw' } })
    expect(body.outline.shapes).toEqual([{ id: 'room', type: 'rectangle', label: 'Küche' }])
    expect(body.canWrite).toBe(true)
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
    const response = await call('PUT', 'doc-svg', { scene: edited, svg: PICTURE, baseVersionId: null })
    expect(response.status).toBe(200)
    const body = await response.json()
    expect(body).toEqual({
      documentId: 'doc-svg',
      versionId: 'doc-svg-v2',
      versionNumber: 2,
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

  it('refuses a stale base Fassung with 409 and the current one, and keeps no bytes for it', async () => {
    await call('PUT', 'doc-svg', { scene: edited, svg: PICTURE, baseVersionId: null })
    const response = await call('PUT', 'doc-svg', { scene: SCENE, svg: PICTURE, baseVersionId: 'doc-svg-v1' })
    expect(response.status).toBe(409)
    expect(await response.json()).toMatchObject({ details: { reason: 'stale_base_version', currentVersionId: 'doc-svg-v2' } })
    expect(discardObject).toHaveBeenCalled()
    expect(versions.filter((v) => v.documentId === 'doc-svg')).toHaveLength(2)
  })

  it('answers 415 for a document without a scene, and 400 for a scene with an image', async () => {
    expect((await call('PUT', 'doc-pdf', { scene: SCENE, svg: PICTURE, baseVersionId: null })).status).toBe(415)
    const withImage = { ...SCENE, elements: [{ id: 'img', type: 'image', x: 0, y: 0 }] }
    const response = await call('PUT', 'doc-svg', { scene: withImage, svg: PICTURE, baseVersionId: null })
    expect(response.status).toBe(400)
    expect(versions).toHaveLength(0)
  })

  it('refuses an SVG the filing validator refuses', async () => {
    const response = await call('PUT', 'doc-svg', { scene: edited, svg: '<svg><script/></svg>', baseVersionId: null })
    expect(response.status).toBe(400)
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
      svg: PICTURE,
      baseVersionId: null,
    })
    const response = await call('PUT', 'doc-svg', {
      scene: { ...SCENE, elements: [{ ...SCENE.elements[0], version: 3, versionNonce: 5 }, { ...SCENE.elements[1], text: 'Speis', version: 3, versionNonce: 6 }] },
      svg: PICTURE,
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
    await call('PUT', 'doc-svg', { scene: edited, svg: PICTURE, baseVersionId: null }, { headers: { [ROOM_PEER_HEADER]: 'peer_anna0001' } })
    expect(roomEvents).toHaveLength(1)
    const [{ documentId, event }] = roomEvents
    expect(documentId).toBe('doc-svg')
    expect(event).toMatchObject({ kind: 'scene.saved', versionId: 'doc-svg-v2', peer: { peerId: 'peer_anna0001', userId: 'user-1', kind: 'person' } })
    expect(event.sceneHash).toBe(sceneHashOf(storedScene('doc-svg').elements))
    // A save without a tab (an agent through MCP) is told under a peer of its own.
    await call('PUT', 'doc-svg', { scene: SCENE, svg: PICTURE, baseVersionId: 'doc-svg-v2' })
    expect((roomEvents[1].event.peer as { peerId: string }).peerId).toMatch(/^save_[0-9a-f]{12}$/)
  })

  it('drops an element link, customData outside the allow-list and appState Excalidraw does not export', async () => {
    const planted = {
      ...SCENE,
      elements: [{ ...SCENE.elements[0], link: 'https://evil.example', customData: { tracker: 1 } }, SCENE.elements[1]],
      appState: { viewBackgroundColor: '#fff', gridSize: 20, theme: 'dark', openDialog: { name: 'ttd' } },
    }
    expect((await call('PUT', 'doc-svg', { scene: planted, svg: PICTURE, baseVersionId: null })).status).toBe(200)
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
    const superseded = await (await call('PUT', 'doc-svg', { scene: edited, svg: PICTURE, baseVersionId: null })).json()
    expect(superseded).toMatchObject({ pdf: null, pdfStale: false })
    // The filed PDF is recorded as Fassung 1, as on every first save; nothing was drawn over it.
    expect(versions.filter((v) => v.documentId === 'doc-pdf').map((v) => v.storageKey)).toEqual(['doc/doc-pdf/file'])

    documents.get('doc-svg')!.publishedVersionId = 'doc-svg-v2'
    renderDiagramPdf.mockRejectedValueOnce(new Error('font missing'))
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const failed = await (await call('PUT', 'doc-svg', { scene: SCENE, svg: PICTURE, baseVersionId: 'doc-svg-v2' })).json()
    expect(failed).toMatchObject({ pdf: null, pdfStale: true })
    expect(recordSketchSaveScore).toHaveBeenLastCalledWith(expect.objectContaining({ outcome: 'pdf_stale', metadata: expect.objectContaining({ pdf: 'failed' }) }))
  })

  it('answers a committed Fassung as saved even when its audit write fails', async () => {
    recordAuditEvent.mockRejectedValueOnce(new Error('audit down'))
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const response = await call('PUT', 'doc-svg', { scene: edited, svg: PICTURE, baseVersionId: null })
    expect(response.status).toBe(200)
    expect((await response.json()).versionNumber).toBe(2)
  })

  it('scores every attempt: saved, a conflict and a refusal', async () => {
    await call('PUT', 'doc-svg', { scene: edited, svg: PICTURE, baseVersionId: null })
    await call('PUT', 'doc-svg', { scene: SCENE, svg: PICTURE, baseVersionId: 'doc-svg-v1' })
    await call('PUT', 'doc-svg', { scene: { ...SCENE, elements: [{ id: 'img', type: 'image', x: 0, y: 0 }] }, svg: PICTURE, baseVersionId: 'doc-svg-v2' })
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

  it('logs a read, but not the preview’s probe', async () => {
    await call('GET', 'doc-svg', undefined, { query: '?probe=1' })
    expect(recordDocumentAccess).not.toHaveBeenCalled()
    await call('GET', 'doc-svg')
    expect(recordDocumentAccess).toHaveBeenCalledTimes(1)
  })
})
