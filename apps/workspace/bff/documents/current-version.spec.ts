/**
 * @vitest-environment node
 *
 * What follows once a Fassung became current (`./current-version.ts`), on every
 * path: the room is told, and a Skizze made current by Freigabe has its pins
 * placed on the promoted scene and its PDF drawn (the interference audit's C2:
 * the room used to hear nothing, so open canvases noticed on their next 409).
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('server-only', () => ({}))
const events: Array<{ documentId: string; event: Record<string, unknown> }> = []
vi.mock('@/lib/realtime/document-channel', () => ({
  publishToDocumentRoom: vi.fn(async (documentId: string, event: Record<string, unknown>) => void events.push({ documentId, event })),
}))
const sketchBecameCurrent = vi.fn()
vi.mock('@/lib/diagrams/sketch-promoted', () => ({ releasedSketch: (...a: unknown[]) => sketchBecameCurrent(...a) }))
const recordSketchPinsKeptScore = vi.fn(async () => {})
vi.mock('@/lib/langfuse/sketch-score', () => ({ recordSketchPinsKeptScore: (...a: unknown[]) => recordSketchPinsKeptScore(...(a as [])) }))

import { versionBecameCurrent } from './current-version'

const session = { userId: 'user_chief', organizationId: 'org_1', email: 'c@example.test', name: 'Eva Chef' } as never
const version = { id: 'ver_3', state: 'published', contentHash: 'h3', screenedHash: null } as never
const filed = {
  id: 'doc_sketch',
  contentType: 'image/svg+xml',
  authoredBy: 'agent',
  authoredByProducer: 'diagram_svg',
  authoredByRef: 'msg_1-1a2b3c4d',
  status: 'stored',
  screeningOutcome: null,
  contentHash: 'h3',
  screenedHash: null,
}
const sketch = filed as never
const pdf = { id: 'doc_pdf', contentType: 'application/pdf', authoredByProducer: null, authoredByRef: null } as never

beforeEach(() => {
  events.length = 0
  sketchBecameCurrent.mockReset()
  recordSketchPinsKeptScore.mockClear()
})

describe('a Fassung made current', () => {
  it('a Freigabe of a Skizze: its pins placed on the promoted scene, every canvas and preview told, the carry scored', async () => {
    sketchBecameCurrent.mockResolvedValue({ sceneHash: 42, placed: ['ann_1', 'ann_2'], lost: ['ann_2'] })
    await versionBecameCurrent({ session, document: sketch, version, carried: { moved: ['ann_1', 'ann_2'], lost: [] } })
    expect(sketchBecameCurrent).toHaveBeenCalledWith(session, sketch, version)
    expect(events.map(({ event }) => event.kind)).toEqual(['annotations.changed', 'scene.saved', 'version.published'])
    expect(events[0].event).toMatchObject({ annotationIds: ['ann_1', 'ann_2'] })
    expect(events[1].event).toMatchObject({ versionId: 'ver_3', sceneHash: 42 })
    expect(recordSketchPinsKeptScore).toHaveBeenCalledWith(expect.objectContaining({ moved: 2, lost: 1, path: 'publish', versionId: 'ver_3' }))
  })

  it('a sketch save hands in its hash and tab: no second read, no echo to the saver', async () => {
    await versionBecameCurrent({
      session,
      document: sketch,
      version,
      carried: { moved: [], lost: [] },
      scene: { sceneHash: 7, peerId: 'peer_anna0001' },
    })
    expect(sketchBecameCurrent).not.toHaveBeenCalled()
    expect(events.map(({ event }) => event.kind)).toEqual(['scene.saved', 'version.published'])
    expect(events[1].event).toMatchObject({ actor: { peerId: 'peer_anna0001' } })
  })

  it('an upload of any other document: the room hears of the new Fassung, and nothing is scored', async () => {
    await versionBecameCurrent({ session, document: pdf, version, carried: { moved: [], lost: [] } })
    expect(events).toEqual([{ documentId: 'doc_pdf', event: expect.objectContaining({ kind: 'version.published', versionId: 'ver_3' }) }])
    expect(recordSketchPinsKeptScore).not.toHaveBeenCalled()
  })

  // ADR-0086: the PDF is machine-authored and never held, so what it draws must be bytes screening let through.
  it('never draws a PDF from bytes a person uploaded, whatever the producer column says', async () => {
    const upload = { ...filed, authoredBy: 'user', status: 'uploaded', screeningOutcome: null, screenedHash: null } as never
    await versionBecameCurrent({ session, document: upload, version, carried: { moved: [], lost: [] } })
    expect(sketchBecameCurrent).not.toHaveBeenCalled()
    expect(events.map(({ event }) => event.kind)).toEqual(['version.published'])
  })

  it('never draws a PDF from a Skizze screening holds', async () => {
    const held = { ...filed, status: 'quarantined' } as never
    await versionBecameCurrent({ session, document: held, version, carried: { moved: [], lost: [] } })
    expect(sketchBecameCurrent).not.toHaveBeenCalled()
  })

  it('never throws: the Fassung is committed whatever the room does', async () => {
    sketchBecameCurrent.mockRejectedValue(new Error('object store down'))
    vi.spyOn(console, 'error').mockImplementation(() => {})
    await expect(versionBecameCurrent({ session, document: sketch, version, carried: { moved: [], lost: [] } })).resolves.toBeUndefined()
  })
})

describe('the carry as a score', () => {
  it('is the share of the moved pins still on an element, one per Fassung', async () => {
    const { toSketchPinsKeptScore } = await vi.importActual<typeof import('@/lib/langfuse/sketch-score')>('@/lib/langfuse/sketch-score')
    const score = toSketchPinsKeptScore({
      traceId: 't1',
      organizationId: 'org_1',
      documentId: 'doc_sketch',
      answerRef: 'msg_1-1a2b3c4d',
      versionId: 'ver_3',
      moved: 4,
      lost: 1,
      path: 'save',
    })
    expect(score).toMatchObject({ id: 'sketch-pins-kept-ver_3', name: 'sketch-pins-kept', dataType: 'NUMERIC', value: 0.75 })
  })
})
