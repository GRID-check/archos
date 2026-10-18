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
  vi.stubGlobal('fetch', fetchMock)
  Object.assign(URL, { createObjectURL: vi.fn(() => 'blob:protokoll'), revokeObjectURL: vi.fn() })
})

afterEach(() => vi.unstubAllGlobals())

const show = (initial: ProjectMarksResponse | null = PAGE) =>
  render(<OpenPointsPanel projectId="proj_1" currentUserId="user_anna" initial={initial} />)

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
    expect(rows[0]).toHaveAttribute('href', '/app/projects/proj_1/files?doc=doc_a&review=1&mark=doc_a_1')
    expect(rows[0]).toHaveTextContent('Fluchttür zu schmal')
    expect(rows[0]).toHaveTextContent('Bernd Huber')
    expect(rows[0]).toHaveTextContent('Page 2')
    expect(within(documents[1]).getByRole('link', { name: 'Open the review of “Schnitt A-A.pdf”' })).toHaveAttribute(
      'href',
      '/app/projects/proj_1/files?doc=doc_b&review=1'
    )
    // The server's first page stands in for the first read.
    expect(fetchMock).not.toHaveBeenCalled()
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

  it('reads the list again for „Me" and says when nothing is in that selection', async () => {
    fetchMock.mockResolvedValue(answer({ marks: [], nextCursor: null }))
    const user = userEvent.setup()
    show()

    await user.click(screen.getByTestId('open-points-assignee-me'))

    expect(fetchMock).toHaveBeenCalledWith('/api/projects/proj_1/annotations?assignee=me', { method: 'GET' })
    expect(await screen.findByText('Nothing in this selection')).toBeInTheDocument()
  })

  it('says a failed read failed, and reads again on „Try again"', async () => {
    fetchMock.mockResolvedValueOnce(answer({ error: 'down', code: 'UNAVAILABLE' }, 503))
    fetchMock.mockResolvedValueOnce(answer(PAGE))
    const user = userEvent.setup()
    show(null)

    expect(await screen.findByText('The open points could not be loaded.')).toBeInTheDocument()
    await user.click(screen.getByTestId('open-points-retry'))

    expect(await screen.findAllByTestId('open-point-row')).toHaveLength(3)
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('says nothing is open when the project has nothing open', () => {
    show({ marks: [], nextCursor: null })
    expect(screen.getByText('Nothing open')).toBeInTheDocument()
  })

  it('reads the next page from where the last one stopped', async () => {
    fetchMock.mockResolvedValue(
      answer({ marks: [mark({ documentId: 'doc_b', documentName: 'Schnitt A-A.pdf', number: 9 })], nextCursor: null })
    )
    const user = userEvent.setup()
    show({ ...PAGE, nextCursor: 'abc' })

    await user.click(screen.getByTestId('load-more-button'))

    expect(fetchMock).toHaveBeenCalledWith('/api/projects/proj_1/annotations?cursor=abc', { method: 'GET' })
    await vi.waitFor(() => expect(screen.getAllByTestId('open-point-row')).toHaveLength(4))
    // The page's mark of Schnitt joins Schnitt's group, not a second one.
    expect(screen.getAllByTestId('open-points-document')).toHaveLength(2)
  })

  it('exports the Protokoll with the filters on screen, and says why one was refused', async () => {
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
