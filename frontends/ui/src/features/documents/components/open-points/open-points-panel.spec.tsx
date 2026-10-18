/**
 * A project's Offene Punkte page: the marks grouped by document, each row the
 * review list's own and a link into that document's review at the mark; the
 * filters read the list again through the typed client; a failed read says so
 * and reads again; the Protokoll carries the filters on screen.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import userEvent from '@testing-library/user-event'

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() } }))
vi.mock('@/lib/analytics/posthog', () => ({ capturePosthog: vi.fn() }))
const nav = vi.hoisted(() => ({ params: new URLSearchParams(), replace: vi.fn() }))
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: nav.replace, back: vi.fn(), refresh: vi.fn(), prefetch: vi.fn() }),
  usePathname: () => '/app/projects/proj_1/files/open-points',
  useSearchParams: () => nav.params,
}))

import { toast } from 'sonner'
import { render, screen, within } from '@/test-utils'
import { captureDownloads } from '@/test-utils/downloads'
import { capturePosthog } from '@/lib/analytics/posthog'
import type { ProjectMarksResponse, ProjectMarkView } from '@/lib/annotations/project-types'
import { OpenPointsPanel } from './open-points-panel'

const mark = (overrides: Partial<ProjectMarkView> = {}): ProjectMarkView => ({
  id: `${overrides.documentId ?? 'doc_a'}_${overrides.number ?? 1}`,
  documentId: 'doc_a',
  documentName: 'Grundriss EG.pdf',
  number: 1,
  page: 2,
  shape: 'point',
  x: 0.5,
  y: 0.5,
  w: null,
  h: null,
  kind: 'defect',
  body: 'Fluchttür zu schmal',
  basis: null,
  authorKind: 'person',
  status: 'open',
  assigneeUserId: null,
  assigneeName: null,
  dueOn: null,
  fassungNumber: 2,
  onCurrentFassung: true,
  createdBy: 'user_anna',
  createdByName: 'Anna Berger',
  createdAt: '2026-10-07T08:00:00.000Z',
  updatedAt: '2026-10-07T08:00:00.000Z',
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
  canDelete: false,
  ...overrides,
})

const PAGE: ProjectMarksResponse = {
  marks: [
    mark({ number: 1, assigneeName: 'Bernd Huber' }),
    mark({ number: 3, body: 'Brandabschnitt prüfen' }),
    mark({ documentId: 'doc_b', documentName: 'Schnitt A-A.pdf', number: 2, body: 'Höhenkote fehlt' }),
  ],
  nextCursor: null,
}

const fetchMock = vi.fn()
const answer = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status })

beforeEach(() => {
  vi.clearAllMocks()
  nav.params = new URLSearchParams()
  fetchMock.mockReset()
  // The page reads its first page again on mount; unless a spec says otherwise, the list is as the server read it.
  fetchMock.mockImplementation(async () => answer(PAGE))
  vi.stubGlobal('fetch', fetchMock)
  Object.assign(URL, { createObjectURL: vi.fn(() => 'blob:protokoll'), revokeObjectURL: vi.fn() })
})

afterEach(() => vi.unstubAllGlobals())

const show = (initial: ProjectMarksResponse | null = PAGE) =>
  render(<OpenPointsPanel projectId="proj_1" currentUserId="user_anna" initial={initial} />)

/** The query of a link's `back`, the page closing its review returns to. */
const backOf = (href: string | null) => new URL(href ?? '', 'https://piloti.test').searchParams.get('back')
const HERE = '/app/projects/proj_1/files/open-points'

describe('OpenPointsPanel', () => {
  it('groups the marks by document, each row a link into that document’s review at the mark', () => {
    show()

    const documents = screen.getAllByTestId('open-points-document')
    expect(documents.map((section) => within(section).getByRole('heading').textContent)).toEqual([
      'Grundriss EG.pdf',
      'Schnitt A-A.pdf',
    ])
    const rows = within(documents[0]).getAllByTestId('open-point-row')
    expect(rows).toHaveLength(2)
    const row = new URL(rows[0].getAttribute('href') ?? '', 'https://piloti.test')
    expect(`${row.pathname}?${row.searchParams.toString()}`).toBe(
      `/app/projects/proj_1/files?doc=doc_a&review=1&mark=doc_a_1&back=${encodeURIComponent(HERE)}`
    )
    expect(rows[0]).toHaveTextContent('Fluchttür zu schmal')
    expect(rows[0]).toHaveTextContent('Bernd Huber')
    expect(rows[0]).toHaveTextContent('Page 2')
    const whole = within(documents[1]).getByRole('link', { name: 'Open the review of “Schnitt A-A.pdf”' })
    expect(whole.getAttribute('href')).toContain('/app/projects/proj_1/files?doc=doc_b&review=1')
    expect(backOf(whole.getAttribute('href'))).toBe(HERE)
  })

  it('reads the first page again on mount, quietly: Back from a review shows what was closed there', async () => {
    fetchMock.mockImplementation(async () => answer({ marks: [PAGE.marks[2]], nextCursor: null }))
    show()
    // The server's page is painted at once, with no spinner, until the fresh read replaces it.
    expect(screen.getAllByTestId('open-point-row')).toHaveLength(3)
    expect(fetchMock).toHaveBeenCalledWith('/api/projects/proj_1/annotations', { method: 'GET' })
    await vi.waitFor(() => expect(screen.getAllByTestId('open-point-row')).toHaveLength(1))
  })

  it('reads it again when the tab comes back into view', async () => {
    show()
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1))
    fetchMock.mockImplementation(async () => answer({ marks: [], nextCursor: null }))
    document.dispatchEvent(new Event('visibilitychange'))
    expect(await screen.findByText('Nothing open')).toBeInTheDocument()
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('keeps the filters in the address, so a review closed from a row comes back to them', async () => {
    nav.params = new URLSearchParams('assignee=me')
    const replaceState = vi.spyOn(window.history, 'replaceState')
    fetchMock.mockImplementation(async () => answer(PAGE))
    const user = userEvent.setup()
    show()
    await vi.waitFor(() => expect(screen.getAllByTestId('open-point-row')).toHaveLength(3))
    expect(fetchMock).toHaveBeenCalledWith('/api/projects/proj_1/annotations?assignee=me', { method: 'GET' })

    await user.click(screen.getByTestId('open-points-due-overdue'))
    // The history entry is replaced in place: no navigation, so no server render of the page.
    expect(replaceState).toHaveBeenLastCalledWith(null, '', `${HERE}?assignee=me&due=overdue`)
    expect(nav.replace).not.toHaveBeenCalled()
    await vi.waitFor(() =>
      expect(backOf(screen.getAllByTestId('open-point-row')[0].getAttribute('href'))).toBe(`${HERE}?assignee=me&due=overdue`)
    )
    replaceState.mockRestore()
  })

  it('names each row by its number and state for a screen reader, as the review list does', () => {
    show({
      marks: [mark({ number: 1 }), mark({ number: 4, kind: 'question', authorKind: 'piloti', status: 'proposed' })],
      nextCursor: null,
    })

    const rows = screen.getAllByTestId('open-point-row')
    expect(rows[0].querySelector('[data-slot="comment-pin"]')).toHaveAttribute('aria-hidden')
    expect(rows[0]).toHaveAccessibleName(/^Annotation 1: Defect\. Fluchttür zu schmal/)
    expect(rows[1]).toHaveAccessibleName(/^Annotation 4: Question · proposal\. /)
  })

  it('reads the list again for „For you" and says when nothing is in that selection', async () => {
    const user = userEvent.setup()
    show()
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1))
    fetchMock.mockImplementation(async () => answer({ marks: [], nextCursor: null }))

    // The review's and Files' word for the same predicate (`isForReader`), never „Me".
    expect(screen.getByTestId('open-points-assignee-me')).toHaveTextContent('For you')
    await user.click(screen.getByTestId('open-points-assignee-me'))

    expect(fetchMock).toHaveBeenCalledWith('/api/projects/proj_1/annotations?assignee=me', { method: 'GET' })
    expect(await screen.findByText('Nothing in this selection')).toBeInTheDocument()
  })

  it('says a failed read failed, and reads again on „Try again"', async () => {
    fetchMock.mockResolvedValueOnce(answer({ error: 'down', code: 'UNAVAILABLE' }, 503))
    const user = userEvent.setup()
    show(null)

    expect(await screen.findByText('The open points could not be loaded.')).toBeInTheDocument()
    await user.click(screen.getByTestId('open-points-retry'))

    expect(await screen.findAllByTestId('open-point-row')).toHaveLength(3)
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('says nothing is open when the project has nothing open', async () => {
    fetchMock.mockImplementation(async () => answer({ marks: [], nextCursor: null }))
    show({ marks: [], nextCursor: null })
    expect(screen.getByText('Nothing open')).toBeInTheDocument()
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1))
  })

  it('reads the next page from where the last one stopped', async () => {
    fetchMock.mockImplementation(async () => answer({ ...PAGE, nextCursor: 'abc' }))
    const user = userEvent.setup()
    show({ ...PAGE, nextCursor: 'abc' })
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1))
    fetchMock.mockImplementation(async () =>
      answer({ marks: [mark({ documentId: 'doc_b', documentName: 'Schnitt A-A.pdf', number: 9 })], nextCursor: null })
    )

    await user.click(screen.getByTestId('load-more-button'))

    expect(fetchMock).toHaveBeenCalledWith('/api/projects/proj_1/annotations?cursor=abc', { method: 'GET' })
    await vi.waitFor(() => expect(screen.getAllByTestId('open-point-row')).toHaveLength(4))
    // The page's mark of Schnitt joins Schnitt's group, not a second one.
    expect(screen.getAllByTestId('open-points-document')).toHaveLength(2)
  })

  it('exports the Protokoll with the filters on screen, and says why one was refused', async () => {
    fetchMock.mockResolvedValueOnce(answer(PAGE))
    fetchMock.mockResolvedValueOnce(answer(PAGE))
    fetchMock.mockResolvedValueOnce(
      new Response(new Blob(['# x']), {
        status: 200,
        headers: { 'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent('Offene Punkte – Lend.md')}` },
      })
    )
    const downloads = captureDownloads()
    const user = userEvent.setup()
    show()

    await user.click(screen.getByTestId('open-points-due-overdue'))
    await user.click(screen.getByRole('button', { name: 'Export minutes' }))
    await user.click(await screen.findByRole('menuitem', { name: 'Markdown' }))

    expect(fetchMock).toHaveBeenLastCalledWith('/api/projects/proj_1/annotations/export?due=overdue&format=md')
    await vi.waitFor(() => expect(downloads).toEqual([{ href: 'blob:protokoll', download: 'Offene Punkte – Lend.md' }]))
    // The CSAT trigger every export fires: the kind and the format, never a name, and only once the file is saved.
    expect(capturePosthog).toHaveBeenCalledTimes(1)
    expect(capturePosthog).toHaveBeenCalledWith('report_exported', { kind: 'open_points', format: 'md' })

    fetchMock.mockResolvedValueOnce(answer({ error: 'x', code: 'UNPROCESSABLE', details: { reason: 'too-many-marks' } }, 422))
    await user.click(screen.getByRole('button', { name: 'Export minutes' }))
    await user.click(await screen.findByRole('menuitem', { name: 'PDF' }))
    await vi.waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith('Too many open points for one set of minutes. Narrow them with a filter.')
    )
    expect(capturePosthog).toHaveBeenCalledTimes(1)
  })
})

describe('filing the project’s Protokoll', () => {
  const filed = (restricted: boolean) => {
    const uploads: FormData[] = []
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url.startsWith('/api/projects/proj_1/annotations/export')) {
        return new Response(new Blob(['%PDF']), { status: 200, headers: { 'content-type': 'application/pdf' } })
      }
      if (url === '/api/documents/upload') {
        uploads.push(init?.body as FormData)
        return answer({ documentId: 'doc_filed', unchanged: false })
      }
      return answer({ ...PAGE, restricted })
    })
    return uploads
  }
  const showFiling = () =>
    render(<OpenPointsPanel projectId="proj_1" currentUserId="user_anna" initial={PAGE} filing={{ projectName: 'Lend' }} />)

  it('files the Protokoll the filters show into the project root, through the upload, named after the project and the day', async () => {
    const uploads = filed(false)
    const user = userEvent.setup()
    showFiling()
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1))

    await user.click(screen.getByTestId('open-points-due-overdue'))
    await user.click(screen.getByRole('button', { name: 'Export minutes' }))
    await user.click(await screen.findByRole('menuitem', { name: 'File in the project' }))

    await vi.waitFor(() => expect(uploads).toHaveLength(1))
    expect(fetchMock).toHaveBeenCalledWith('/api/projects/proj_1/annotations/export?due=overdue&format=pdf')
    const form = uploads[0]!
    expect(form.get('projectId')).toBe('proj_1')
    // The root: every member reads it, which is why it is offered only for what every member may read.
    expect(form.get('folderId')).toBeNull()
    expect((form.get('file') as File).name).toMatch(/^Open points – Lend – \d{4}-\d{2}-\d{2}\.pdf$/)
    await vi.waitFor(() =>
      expect(toast.success).toHaveBeenCalledWith(expect.stringMatching(/^Filed as “Open points – Lend – /), expect.anything())
    )
  })

  it('withholds it, and says why, while the selection quotes a document not everyone in the project may open', async () => {
    const uploads = filed(true)
    const user = userEvent.setup()
    showFiling()
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1))

    await user.click(screen.getByRole('button', { name: 'Export minutes' }))
    const item = await screen.findByTestId('open-points-export-file')
    expect(item).toHaveAttribute('aria-disabled', 'true')
    expect(item).toHaveTextContent('some points are on documents not everyone in the project may open')
    await user.click(item)
    expect(uploads).toHaveLength(0)
  })

  it('is not offered where the reader may not file into the project root', async () => {
    filed(false)
    const user = userEvent.setup()
    show()
    await user.click(screen.getByRole('button', { name: 'Export minutes' }))
    await screen.findByRole('menuitem', { name: 'PDF' })
    expect(screen.queryByTestId('open-points-export-file')).toBeNull()
  })
})
