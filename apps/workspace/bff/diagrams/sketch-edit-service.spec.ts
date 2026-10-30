/**
 * @vitest-environment node
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('server-only', () => ({}))
vi.mock('./sketch-document', () => ({ sketchSaveBaseOf: vi.fn(), saveSketchDocument: vi.fn(), sketchSceneOfText: vi.fn() }))
vi.mock('./sketch-target', () => ({ sketchTargetOf: vi.fn() }))
vi.mock('./sketch-renderer', () => ({ sketchRenderer: () => ({ render: vi.fn(async () => ({ svg: '<svg/>', remeasured: [], ms: 1 })) }) }))
vi.mock('@/lib/documents/version-content', () => ({ readVersionContent: vi.fn(async () => 'svg-text') }))
vi.mock('@/lib/documents/version-repository', () => ({ findDocumentVersion: vi.fn(), findPreviousVersion: vi.fn() }))
vi.mock('@/lib/download-log/service', () => ({ recordDocumentAccess: vi.fn() }))
vi.mock('@/lib/langfuse/sketch-score', () => ({ recordSketchEditScore: vi.fn(async () => undefined) }))

import type { AuthorizedSession } from '@/lib/auth/types'
import type { Document } from '@/lib/db/schema/documents'
import type { DocumentVersion } from '@/lib/db/schema/document-versions'
import { PublishedVersionMovedError } from '@/lib/documents/published-guard'
import { readVersionContent } from '@/lib/documents/version-content'
import { findDocumentVersion, findPreviousVersion } from '@/lib/documents/version-repository'
import { recordSketchEditScore } from '@/lib/langfuse/sketch-score'
import { saveSketchDocument, sketchSaveBaseOf, sketchSceneOfText, type SketchSaveBase } from './sketch-document'
import {
  checkSketchEditProposal,
  editSketchDocument,
  previewSketchEdit,
  revertSketchDocument,
  SketchChangedError,
  SketchMovedOnError,
} from './sketch-edit-service'
import { withProposingTurn } from '@/lib/proposals/proposing-turn'
import { checkSketchScene } from './sketch-scene'
import { sketchTargetOf } from './sketch-target'

const SESSION = { userId: 'u1', organizationId: 'org_1' } as AuthorizedSession
const DOCUMENT = { id: 'doc_1', organizationId: 'org_1', authoredByRef: 'answer-1-0123abcd', publishedVersionId: 'ver_2' } as Document
const scene = (extra: Record<string, unknown>[] = []) =>
  checkSketchScene({
    type: 'excalidraw',
    elements: [
      { id: 'hall', type: 'rectangle', x: 0, y: 0, width: 160, height: 80 },
      { id: 'store', type: 'rectangle', x: 300, y: 0, width: 160, height: 80 },
      ...extra,
    ],
  })
const base = (versionId: string, extra?: Record<string, unknown>[]): SketchSaveBase => ({
  document: DOCUMENT,
  scene: scene(extra),
  versionId,
  contentHash: null,
  target: 'published',
})
const remove = { op: 'remove' as const, intent: 'Drop the store', id: 'store' }
const outcomes = () => vi.mocked(recordSketchEditScore).mock.calls.map(([input]) => input.outcome)

beforeEach(() => {
  vi.clearAllMocks()
  // The Fassung an edit was made on, read for a rebase: the same scene unless a spec says otherwise.
  vi.mocked(sketchSceneOfText).mockReturnValue(scene())
  vi.mocked(saveSketchDocument).mockResolvedValue({
    documentId: 'doc_1',
    versionId: 'ver_3',
    versionNumber: 3,
    state: 'published',
    contentHash: null,
    pdf: null,
    pdfStale: false,
    answerRef: 'answer-1-0123abcd',
    pdfOutcome: 'none',
  })
})

describe('editSketchDocument', () => {
  const edit = (body: Parameters<typeof editSketchDocument>[0]['body']) =>
    editSketchDocument({ session: SESSION, documentId: 'doc_1', body, marking: 'edited' })

  it('saves the edited scene on the Fassung it was made for, without the removed element', async () => {
    vi.mocked(sketchSaveBaseOf).mockResolvedValue(base('ver_2'))
    const saved = await edit({ baseVersionId: 'ver_2', ops: [remove] })
    expect(saved).toMatchObject({ versionId: 'ver_3', rebased: false, diff: { removed: ['store'] } })
    const body = vi.mocked(saveSketchDocument).mock.calls[0][0].body
    expect(body.baseVersionId).toBe('ver_2')
    expect((body.scene.elements as { id: string }[]).map((element) => element.id)).toEqual(['hall'])
    expect(outcomes()).toEqual(['accepted'])
  })

  it('rebases onto a newer Fassung when every id it names is still drawn', async () => {
    vi.mocked(sketchSaveBaseOf).mockResolvedValue(base('ver_5', [{ id: 'bath', type: 'ellipse', x: 0, y: 300, width: 100, height: 60 }]))
    const saved = await edit({ baseVersionId: 'ver_2', ops: [remove] })
    expect(saved).toMatchObject({ rebased: true })
    expect(vi.mocked(saveSketchDocument).mock.calls[0][0].body.baseVersionId).toBe('ver_5')
    expect(outcomes()).toEqual(['rebased'])
  })

  it('refuses a rebase when a colleague changed the element the edit names in between', async () => {
    vi.mocked(sketchSaveBaseOf).mockResolvedValue({
      ...base('ver_5'),
      scene: checkSketchScene({
        type: 'excalidraw',
        elements: [
          { id: 'hall', type: 'rectangle', x: 0, y: 0, width: 160, height: 80 },
          { id: 'store', type: 'rectangle', x: 500, y: 0, width: 160, height: 80, version: 4, versionNonce: 99 },
        ],
      }),
    })
    vi.mocked(sketchSceneOfText).mockReturnValue(
      checkSketchScene({
        type: 'excalidraw',
        elements: [
          { id: 'hall', type: 'rectangle', x: 0, y: 0, width: 160, height: 80 },
          { id: 'store', type: 'rectangle', x: 300, y: 0, width: 160, height: 80, version: 3, versionNonce: 7 },
        ],
      })
    )
    await expect(edit({ baseVersionId: 'ver_2', ops: [remove] })).rejects.toBeInstanceOf(SketchChangedError)
    expect(readVersionContent).toHaveBeenCalledWith(SESSION, 'doc_1', 'ver_2')
    expect(saveSketchDocument).not.toHaveBeenCalled()
    expect(outcomes()).toEqual(['refused'])
  })

  it('applies once more onto the newer Fassung when a colleague saved during the render', async () => {
    vi.mocked(sketchSaveBaseOf).mockResolvedValueOnce(base('ver_2')).mockResolvedValueOnce(base('ver_3'))
    vi.mocked(saveSketchDocument).mockRejectedValueOnce(new PublishedVersionMovedError('doc_1', 'ver_3'))
    const saved = await edit({ baseVersionId: 'ver_2', ops: [remove] })
    expect(saved).toMatchObject({ versionId: 'ver_3', rebased: true })
    expect(vi.mocked(saveSketchDocument).mock.calls.map(([call]) => call.body.baseVersionId)).toEqual(['ver_2', 'ver_3'])
    expect(outcomes()).toEqual(['rebased'])
  })

  it('refuses when a newer Fassung lost an element the edit names', async () => {
    vi.mocked(sketchSaveBaseOf).mockResolvedValue({ ...base('ver_5'), scene: checkSketchScene({ type: 'excalidraw', elements: [] }) })
    await expect(edit({ baseVersionId: 'ver_2', ops: [remove] })).rejects.toBeInstanceOf(SketchChangedError)
    expect(saveSketchDocument).not.toHaveBeenCalled()
  })

  it('declines with a note and saves nothing', async () => {
    expect(await edit({ baseVersionId: 'ver_2', ops: [], note: 'Eine Skizze behauptet keine Maße.' })).toEqual({
      declined: true,
      note: 'Eine Skizze behauptet keine Maße.',
    })
    await expect(edit({ baseVersionId: 'ver_2', ops: [] })).rejects.toMatchObject({ status: 422 })
    expect(saveSketchDocument).not.toHaveBeenCalled()
  })
})

describe('checkSketchEditProposal', () => {
  const check = (body: unknown) => checkSketchEditProposal({ params: { id: 'doc_1' }, body }, SESSION)

  it('passes a valid edit with its warnings, refuses a wrong one with the op named, declines no ops', async () => {
    vi.mocked(sketchSaveBaseOf).mockResolvedValue(base('ver_2'))
    const added = { op: 'add', intent: 'Add a WC on the hall', element: { type: 'rectangle', id: 'wc', x: 10, y: 10, width: 60, height: 40 } }
    expect((await check({ baseVersionId: 'ver_2', ops: [added] })).warnings).toEqual(['wc overlaps hall'])
    await expect(check({ baseVersionId: 'ver_2', ops: [{ op: 'remove', intent: 'x', id: 'nope' }] })).rejects.toMatchObject({
      status: 422,
      message: expect.stringContaining('Operation 1 (nope)'),
    })
    expect(await check({ baseVersionId: 'ver_2', ops: [], note: 'Keine Maße.' })).toEqual({ decline: 'Keine Maße.' })
    expect(outcomes()).toEqual(['proposed', 'refused', 'declined'])
  })
})

describe('where the edit is scored', () => {
  const proposingOf = () => vi.mocked(recordSketchEditScore).mock.calls.map(([input]) => input.proposingMessageId)

  it('scores the check on the turn that proposes it', async () => {
    vi.mocked(sketchSaveBaseOf).mockResolvedValue(base('ver_2'))
    await checkSketchEditProposal({ params: { id: 'doc_1' }, body: { baseVersionId: 'ver_2', ops: [remove] } }, SESSION, { answerMessageId: 'msg_9' })
    expect(proposingOf()).toEqual(['msg_9'])
  })

  it('scores the apply of a proposal on the turn that proposed it', async () => {
    vi.mocked(sketchSaveBaseOf).mockResolvedValue(base('ver_2'))
    await withProposingTurn('msg_9', () => editSketchDocument({ session: SESSION, documentId: 'doc_1', body: { baseVersionId: 'ver_2', ops: [remove] }, marking: 'edited' }))
    expect(proposingOf()).toEqual(['msg_9'])
  })

  it('scores a failed preview and a failed undo', async () => {
    vi.mocked(sketchSaveBaseOf).mockResolvedValue(base('ver_2'))
    await expect(previewSketchEdit(SESSION, 'doc_1', { baseVersionId: 'ver_2', ops: [{ op: 'remove', intent: 'x', id: 'nope' }] })).rejects.toThrow()
    vi.mocked(sketchTargetOf).mockResolvedValue({ kind: 'published' })
    await expect(revertSketchDocument({ session: SESSION, documentId: 'doc_1', body: { versionId: 'ver_1' }, marking: 'edited' })).rejects.toThrow()
    expect(vi.mocked(recordSketchEditScore).mock.calls.map(([input]) => [input.outcome, input.refusal, input.metadata?.step])).toEqual([
      ['failed', 'unknown-id', 'preview'],
      ['failed', 'moved_on', 'undo'],
    ])
  })
})

describe('previewSketchEdit', () => {
  it('draws the edit on the Fassung it names, read as the person', async () => {
    vi.mocked(sketchSaveBaseOf).mockResolvedValue(base('ver_5'))
    vi.mocked(sketchSceneOfText).mockReturnValue(scene())
    const preview = await previewSketchEdit(SESSION, 'doc_1', { baseVersionId: 'ver_2', ops: [remove] })
    expect(readVersionContent).toHaveBeenCalledWith(SESSION, 'doc_1', 'ver_2')
    expect(preview).toMatchObject({ baseVersionId: 'ver_2', diff: { removed: ['store'] }, svg: '<svg/>' })
  })
})

describe('revertSketchDocument', () => {
  const revert = (versionId: string) => revertSketchDocument({ session: SESSION, documentId: 'doc_1', body: { versionId }, marking: 'edited' })

  it('saves the Fassung before the current one as the next', async () => {
    vi.mocked(sketchSaveBaseOf).mockResolvedValue(base('ver_2'))
    vi.mocked(sketchTargetOf).mockResolvedValue({ kind: 'published' })
    vi.mocked(findDocumentVersion).mockResolvedValue({ id: 'ver_2', versionNumber: 2 } as DocumentVersion)
    vi.mocked(findPreviousVersion).mockResolvedValue({ id: 'ver_1', versionNumber: 1 } as DocumentVersion)
    vi.mocked(sketchSceneOfText).mockReturnValue(scene())
    await revert('ver_2')
    expect(readVersionContent).toHaveBeenCalledWith(SESSION, 'doc_1', 'ver_1')
    expect(vi.mocked(saveSketchDocument).mock.calls[0][0].body.baseVersionId).toBe('ver_2')
    expect(outcomes()).toEqual(['undone'])
  })

  it('refuses once another Fassung came after', async () => {
    vi.mocked(sketchSaveBaseOf).mockResolvedValue(base('ver_2'))
    vi.mocked(sketchTargetOf).mockResolvedValue({ kind: 'published' })
    await expect(revert('ver_1')).rejects.toBeInstanceOf(SketchMovedOnError)
    expect(saveSketchDocument).not.toHaveBeenCalled()
  })
})
