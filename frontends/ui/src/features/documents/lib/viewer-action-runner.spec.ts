/**
 * The runner of a viewer action (ADR-0144): the person's own read decides what
 * may open, the viewer moves the way the person's own clicks move it, and every
 * undo says whether it put anything back.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ViewerActionCall, ViewerActionName } from '@/features/chat/lib/viewer-actions'
import { useChatStore } from '@/features/chat/store'
import { useFilePreviewStore } from '../stores/file-preview-store'
import type { FileItem } from '../components/project-file-workspace'
import { createViewerActionRunner, type ViewerActionRunnerDeps } from './viewer-action-runner'

type Row = ReturnType<typeof row>

const row = (id: string, filename: string, extra: Record<string, unknown> = {}) => ({
  id,
  filename,
  fileSize: 10,
  contentType: 'application/pdf',
  status: 'completed',
  createdAt: '2026-10-01T00:00:00.000Z',
  projectId: 'proj-1' as string | null,
  collectionName: 'proj_1',
  revision: null as unknown,
  ...extra,
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

/** `GET /api/documents/{id}` over these rows; an id not among them is a 404 (or `status`). */
const documents = (rows: Row[], status = 404) =>
  vi.fn(async (input: RequestInfo | URL) => {
    const id = decodeURIComponent(String(input).split('/').pop() ?? '')
    const found = rows.find((candidate) => candidate.id === id)
    return found
      ? new Response(JSON.stringify({ document: found }), { status: 200 })
      : new Response(null, { status })
  })

const deps = (fetcher: ReturnType<typeof documents>, overrides: Partial<ViewerActionRunnerDeps> = {}) => ({
  hasRoom: () => true,
  openCompare: vi.fn(),
  closeCompare: vi.fn(() => true),
  navigate: vi.fn(),
  currentHref: vi.fn(() => '/app/projects/proj-1/chat'),
  fetcher: fetcher as unknown as typeof fetch,
  ...overrides,
})

beforeEach(() => {
  useFilePreviewStore.getState().close()
  useChatStore.setState({ composerSubject: null })
})

describe('the read before anything moves', () => {
  it('asks the document as Files does, GET /api/documents/{id}, and no route of its own', async () => {
    const fetcher = documents([row('doc-1', 'Baubeschreibung.pdf')])
    await createViewerActionRunner(deps(fetcher)).run(call('open_document'))
    expect(fetcher).toHaveBeenCalledOnce()
    expect(String(fetcher.mock.calls[0]![0])).toBe('/api/documents/doc-1')
  })

  it.each([403, 404])('refuses on a %i, neutrally, and the viewer stays as it was', async (status) => {
    const open = { id: 'mine', filename: 'Eigenes.pdf' } as FileItem
    useFilePreviewStore.getState().open(open, 'peek')

    const outcome = await createViewerActionRunner(deps(documents([], status))).run(call('highlight_passage', { page: 2, passage: 'x' }))

    expect(outcome).toEqual({ outcome: 'refused', reason: 'unavailable' })
    expect(useFilePreviewStore.getState().file?.id).toBe('mine')
    expect(useFilePreviewStore.getState().viewerTarget).toBeNull()
  })

  it('fails, and moves nothing, when the read cannot be made or answers another document', async () => {
    const thrown = vi.fn(async () => {
      throw new Error('offline')
    })
    expect(await createViewerActionRunner(deps(thrown as never)).run(call('open_document'))).toEqual({ outcome: 'failed' })
    const other = documents([row('doc-1', 'x.pdf', { id: 'doc-2' })])
    other.mockImplementation(async () => new Response(JSON.stringify({ document: row('doc-2', 'y.pdf') }), { status: 200 }))
    expect(await createViewerActionRunner(deps(other)).run(call('open_document'))).toEqual({ outcome: 'failed' })
    expect(useFilePreviewStore.getState().file).toBeNull()
  })
})

describe('a place beside the chat', () => {
  it('opens the passage in the peek without taking over the composer, and the undo shuts it', async () => {
    const runner = createViewerActionRunner(deps(documents([row('doc-1', 'Baubeschreibung.pdf')])))

    const outcome = await runner.run(call('highlight_passage', { page: 4, passage: 'Fluchtwege 1,20 m' }))

    const store = useFilePreviewStore.getState()
    expect(store.file?.id).toBe('doc-1')
    expect(store.mode).toBe('peek')
    expect(store.viewerTarget).toMatchObject({ fileId: 'doc-1', page: 4, passage: 'Fluchtwege 1,20 m' })
    expect(useChatStore.getState().composerSubject).toBeNull()
    if (outcome.outcome !== 'shown') throw new Error('expected shown')
    expect(outcome.where).toBe('beside')
    expect(outcome.undo()).toBe(true)
    expect(useFilePreviewStore.getState().file).toBeNull()
  })

  it('puts back the document that was open before', async () => {
    const before = { id: 'mine', filename: 'Eigenes.pdf' } as FileItem
    useFilePreviewStore.getState().open(before, 'peek')
    const runner = createViewerActionRunner(deps(documents([row('doc-1', 'Baubeschreibung.pdf')])))

    const outcome = await runner.run(call('open_document', { page: 3 }))
    if (outcome.outcome !== 'shown') throw new Error('expected shown')

    expect(outcome.undo()).toBe(true)
    expect(useFilePreviewStore.getState().file?.id).toBe('mine')
  })

  it('leaves a document the person opened since, and says it did nothing', async () => {
    const runner = createViewerActionRunner(deps(documents([row('doc-1', 'Baubeschreibung.pdf')])))
    const outcome = await runner.run(call('open_document'))
    if (outcome.outcome !== 'shown') throw new Error('expected shown')
    useFilePreviewStore.getState().open({ id: 'theirs', filename: 'Andere.pdf' } as FileItem, 'peek')

    expect(outcome.undo()).toBe(false)
    expect(useFilePreviewStore.getState().file?.id).toBe('theirs')
  })

  it('marks the box of a highlight_region on its page', async () => {
    const runner = createViewerActionRunner(deps(documents([row('doc-1', 'Grundriss.pdf')])))
    await runner.run(call('highlight_region', { page: 1, region: [0.1, 0.2, 0.3, 0.4] }))
    expect(useFilePreviewStore.getState().viewerTarget?.regions?.length).toBe(1)
  })
})

describe('no room beside the chat (a phone)', () => {
  it('opens the same pane over the chat, so „Anzeigen“ shows what it says it shows', async () => {
    const runner = createViewerActionRunner(deps(documents([row('doc-1', 'Baubeschreibung.pdf')]), { hasRoom: () => false }))

    const outcome = await runner.run(call('highlight_passage', { page: 4, passage: 'Fluchtwege' }))

    if (outcome.outcome !== 'shown') throw new Error('expected shown')
    expect(outcome.where).toBe('over')
    expect(useFilePreviewStore.getState().mode).toBe('modal')
    expect(useFilePreviewStore.getState().viewerTarget).toMatchObject({ fileId: 'doc-1', page: 4 })
    expect(outcome.undo()).toBe(true)
    expect(useFilePreviewStore.getState().file).toBeNull()
  })
})

describe('a Fassung comparison', () => {
  const newer = row('doc-new', 'Grundriss EG.pdf', {
    revision: { supersededBy: null, supersedes: [{ id: 'doc-old', filename: 'Grundriss EG_VE.pdf' }], suggestion: null, changeSummary: null },
  })
  const older = row('doc-old', 'Grundriss EG_VE.pdf')
  const compare = (document: string, against: string) =>
    call('compare_revisions', { document_id: document, against_document_id: against, against_document_name: 'x' })

  it('reads both documents at once and opens two Fassungen of one document, older first', async () => {
    const fetcher = documents([newer, older])
    const handles = deps(fetcher)

    const outcome = await createViewerActionRunner(handles).run(compare('doc-new', 'doc-old'))

    expect(fetcher).toHaveBeenCalledTimes(2)
    expect(handles.openCompare).toHaveBeenCalledWith(
      { id: 'doc-old', filename: 'Grundriss EG_VE.pdf' },
      { id: 'doc-new', filename: 'Grundriss EG.pdf' }
    )
    if (outcome.outcome !== 'shown') throw new Error('expected shown')
    expect(outcome.undo()).toBe(true)
    expect(handles.closeCompare).toHaveBeenCalledWith(
      { id: 'doc-old', filename: 'Grundriss EG_VE.pdf' },
      { id: 'doc-new', filename: 'Grundriss EG.pdf' }
    )
  })

  it('orders the pair by the links whichever way round the action named it', async () => {
    const handles = deps(documents([newer, older]))
    await createViewerActionRunner(handles).run(compare('doc-old', 'doc-new'))
    expect(handles.openCompare).toHaveBeenCalledWith(expect.objectContaining({ id: 'doc-old' }), expect.objectContaining({ id: 'doc-new' }))
  })

  it('refuses two documents nobody linked as Fassungen, and two on different shelves', async () => {
    const stranger = row('doc-x', 'Schnitt.pdf')
    const elsewhere = row('doc-old', 'Grundriss EG_VE.pdf', { collectionName: 'archiv_1', projectId: null })
    const handles = deps(documents([newer, stranger]))

    expect(await createViewerActionRunner(handles).run(compare('doc-new', 'doc-x'))).toEqual({ outcome: 'refused', reason: 'notRevisions' })
    expect(await createViewerActionRunner(deps(documents([newer, elsewhere]))).run(compare('doc-new', 'doc-old'))).toEqual({
      outcome: 'refused',
      reason: 'notRevisions',
    })
    expect(handles.openCompare).not.toHaveBeenCalled()
  })

  it('refuses when either Fassung is not the person’s to read', async () => {
    const handles = deps(documents([newer]))
    expect(await createViewerActionRunner(handles).run(compare('doc-new', 'doc-old'))).toEqual({ outcome: 'refused', reason: 'unavailable' })
    expect(handles.openCompare).not.toHaveBeenCalled()
  })

  it('says it did nothing when another comparison is open now', async () => {
    const handles = deps(documents([newer, older]), { closeCompare: vi.fn(() => false) })
    const outcome = await createViewerActionRunner(handles).run(compare('doc-new', 'doc-old'))
    if (outcome.outcome !== 'shown') throw new Error('expected shown')
    expect(outcome.undo()).toBe(false)
  })
})

describe('a model element', () => {
  const model = row('doc-ifc', 'Haus A.ifc')
  const focus = call('focus_ifc_element', { document_id: 'doc-ifc', document_name: 'Haus A.ifc', element: '1kTvQ9x8n5RfBW2$hK0aZq' })

  it('goes to the model view with the element, and back to the page it came from while still there', async () => {
    let here = '/app/projects/proj-1/chat?c=1'
    const handles = deps(documents([model]), {
      currentHref: () => here,
      navigate: vi.fn((href: string) => {
        here = href
      }),
    })

    const outcome = await createViewerActionRunner(handles).run(focus)

    const href = String((handles.navigate as ReturnType<typeof vi.fn>).mock.calls[0]![0])
    expect(href).toContain('proj-1')
    if (outcome.outcome !== 'shown') throw new Error('expected shown')
    expect(outcome.where).toBe('model')
    expect(outcome.undo()).toBe(true)
    expect(here).toBe('/app/projects/proj-1/chat?c=1')
  })

  it('stays where the person went on to, and says it did nothing', async () => {
    let here = '/app/projects/proj-1/chat'
    const navigate = vi.fn((href: string) => {
      here = href
    })
    const outcome = await createViewerActionRunner(deps(documents([model]), { currentHref: () => here, navigate })).run(focus)
    here = '/app/projects/proj-1/files'
    if (outcome.outcome !== 'shown') throw new Error('expected shown')

    expect(outcome.undo()).toBe(false)
    expect(navigate).toHaveBeenCalledTimes(1)
    expect(here).toBe('/app/projects/proj-1/files')
  })
})
