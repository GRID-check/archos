/**
 * The runner of a viewer action (ADR-0142): the BFF decides what may open,
 * the viewer moves the way the person's own clicks move it, and every move
 * can be undone.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ViewerActionCall, ViewerActionName } from '@/features/chat/lib/viewer-actions'
import { useChatStore } from '@/features/chat/store'
import { useFilePreviewStore } from '../stores/file-preview-store'
import type { FileItem } from '../components/project-file-workspace'
import { createViewerActionRunner } from './viewer-action-runner'

const row = (id: string, filename: string, projectId: string | null = 'proj-1') => ({
  id,
  filename,
  fileSize: 10,
  contentType: 'application/pdf',
  status: 'completed',
  createdAt: '2026-10-01T00:00:00.000Z',
  projectId,
})

const call = (name: ViewerActionName, args: Partial<ViewerActionCall['args']> = {}): ViewerActionCall => ({
  tool_call_id: `va_${name}`,
  tool_call_name: name,
  args: {
    document_id: 'doc-1',
    document_name: 'Baubeschreibung.pdf',
    page: null,
    passage: null,
    region: null,
    against_document_id: null,
    against_document_name: null,
    element: null,
    ...args,
  },
})

const answer = (status: number, body?: unknown) =>
  vi.fn(async () => new Response(body === undefined ? null : JSON.stringify(body), { status }))

const deps = (fetcher: ReturnType<typeof answer>) => ({
  hasRoom: () => true,
  openCompare: vi.fn(),
  closeCompare: vi.fn(),
  navigate: vi.fn(),
  back: vi.fn(),
  fetcher: fetcher as unknown as typeof fetch,
})

beforeEach(() => {
  useFilePreviewStore.getState().close()
  useChatStore.setState({ composerSubject: null })
})

describe('a document the person may not see', () => {
  it.each([403, 404])('is refused on a %i and the viewer stays as it was', async (status) => {
    const open = { id: 'mine', filename: 'Eigenes.pdf' } as FileItem
    useFilePreviewStore.getState().open(open, 'peek')
    const fetcher = answer(status)

    const result = await createViewerActionRunner(deps(fetcher)).run(call('open_document', { page: 2 }))

    expect(result).toEqual({ outcome: 'refused' })
    expect(fetcher).toHaveBeenCalledWith('/api/documents/doc-1/viewer-place', expect.anything())
    expect(useFilePreviewStore.getState().file?.id).toBe('mine')
  })

  it('is refused when the BFF answers for another document than the one asked', async () => {
    const result = await createViewerActionRunner(deps(answer(200, { document: row('doc-2', 'x.pdf') }))).run(
      call('open_document')
    )
    expect(result).toEqual({ outcome: 'failed' })
    expect(useFilePreviewStore.getState().file).toBeNull()
  })
})

describe('a document the person may see', () => {
  it('opens beside the chat at the passage, binds no subject, and goes back on undo', async () => {
    const previous = { id: 'mine', filename: 'Eigenes.pdf' } as FileItem
    useFilePreviewStore.getState().open(previous, 'peek')
    const runner = createViewerActionRunner(deps(answer(200, { document: row('doc-1', 'Baubeschreibung.pdf') })))

    const result = await runner.run(call('highlight_passage', { page: 4, passage: 'Fluchtwege 1,20 m' }))

    const store = useFilePreviewStore.getState()
    expect(result.outcome).toBe('shown')
    expect(store.file?.id).toBe('doc-1')
    expect(store.mode).toBe('peek')
    expect(store.viewerTarget).toMatchObject({ fileId: 'doc-1', page: 4, passage: 'Fluchtwege 1,20 m', regions: null })
    expect(useChatStore.getState().composerSubject).toBeNull()

    if (result.outcome === 'shown') result.undo()
    expect(useFilePreviewStore.getState().file?.id).toBe('mine')
  })

  it('marks a box in the viewer’s own frame', async () => {
    const runner = createViewerActionRunner(deps(answer(200, { document: row('doc-1', 'Grundriss.pdf') })))

    await runner.run(call('highlight_region', { page: 1, region: [0.5, 0.1, 0.3, 0.25] }))

    expect(useFilePreviewStore.getState().viewerTarget?.regions).toEqual([{ box: [0.5, 0.1, 0.8, 0.35] }])
  })

  it('shuts the peek on undo when none was open', async () => {
    const runner = createViewerActionRunner(deps(answer(200, { document: row('doc-1', 'Baubeschreibung.pdf') })))
    const result = await runner.run(call('open_document'))
    if (result.outcome === 'shown') result.undo()
    expect(useFilePreviewStore.getState().file).toBeNull()
  })

  it('compares two Fassungen only when the BFF read both', async () => {
    const both = { document: row('doc-1', 'Grundriss.pdf'), against: row('doc-0', 'Grundriss_alt.pdf') }
    const d = deps(answer(200, both))

    const result = await createViewerActionRunner(d).run(call('compare_revisions', { against_document_id: 'doc-0' }))

    expect(d.openCompare).toHaveBeenCalledWith({ id: 'doc-0', filename: 'Grundriss_alt.pdf' }, { id: 'doc-1', filename: 'Grundriss.pdf' })
    if (result.outcome === 'shown') result.undo()
    expect(d.closeCompare).toHaveBeenCalledOnce()
  })

  it('opens the model view at the element', async () => {
    const d = deps(answer(200, { document: { ...row('doc-1', 'Haus A.ifc'), contentType: 'application/x-step' } }))

    await createViewerActionRunner(d).run(call('focus_ifc_element', { element: '1kTvQ9x8n5RfBW2$hK0aZq' }))

    const href = d.navigate.mock.calls[0]![0] as string
    expect(href).toMatch(/^\/app\/projects\/proj-1\/files\?/)
    expect(decodeURIComponent(href)).toContain('1kTvQ9x8n5RfBW2$hK0aZq')
  })
})
