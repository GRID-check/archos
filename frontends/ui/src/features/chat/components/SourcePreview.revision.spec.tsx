/**
 * A citation of an older Fassung says so, and reaches the current one.
 *
 * The cited document resolves by name through the by-name route, whose listing row carries the
 * reader-visible `fassung.supersededBy` (a newer document a person confirmed; one the reader may not
 * open is not in it, name and all). The peek turns that into one muted line with the current
 * Fassung's name as the control. A document nobody replaced shows no line.
 */

import { render, screen, waitFor } from '@/test-utils'
import userEvent from '@testing-library/user-event'
import { vi, describe, test, expect, beforeEach, afterEach } from 'vitest'
import { buildCitationModel, type CitationRef } from '../lib/citations'
import type { CitationSource } from '../types'
import { SourcePreviewChip, resetSourcePreviewIndexCache } from './SourcePreview'

vi.mock('../store', () => ({
  useChatStore: (
    selector: (s: {
      projectId: string | null
      currentConversation: { id: string } | null
    }) => unknown
  ) => selector({ projectId: 'project-1', currentConversation: { id: 'conv-1' } }),
}))

const open = vi.hoisted(() => ({ openFilePeek: vi.fn() }))
vi.mock('@/features/documents/lib/open-file-peek', () => open)

const toastError = vi.hoisted(() => vi.fn())
vi.mock('sonner', () => ({ toast: { error: toastError, loading: vi.fn(), dismiss: vi.fn() } }))

const jsonResponse = (data: unknown) => ({ ok: true, json: async () => data })

const row = (id: string, filename: string, extra: Record<string, unknown> = {}) => ({
  id,
  filename,
  contentType: 'application/pdf',
  status: 'completed',
  createdAt: '2026-08-01T00:00:00.000Z',
  ...extra,
})

/** What `POST /api/documents/by-name` answers, by the names asked for. */
let rows: Record<string, ReturnType<typeof row>> = {}

const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
  if (String(input) === '/api/documents/by-name') {
    const names = (JSON.parse(String(init?.body)) as { names: string[] }).names
    return Promise.resolve(
      jsonResponse({ documents: names.map((name) => rows[name.toLowerCase()]).filter(Boolean) })
    )
  }
  return Promise.resolve(jsonResponse({ documents: [], files: [] }))
})

const refTo = (fileName: string): CitationRef => {
  const source: CitationSource = {
    id: 'c-1',
    url: '',
    content: `[KB] ${fileName}, p.3`,
    citationKey: `${fileName}, p.3`,
    fileName,
    collection: 'proj_1',
    kind: 'project',
    page: 3,
    number: 1,
    isCited: true,
    timestamp: new Date('2026-07-17T10:00:00Z'),
  }
  const [document] = buildCitationModel({ citations: [source] })
  if (!document) throw new Error('fixture produced no document')
  return { document, locus: document.loci[0] }
}

const OLD = 'Statik_Index_B.pdf'
const CURRENT = 'Statik_Index_C.pdf'

const replaced = {
  fassung: {
    supersededBy: { id: 'doc-c', filename: CURRENT },
    supersedes: [],
    suggestion: null,
    changeSummary: null,
  },
}

describe('a citation of an older revision', () => {
  beforeEach(() => {
    resetSourcePreviewIndexCache()
    fetchMock.mockClear()
    open.openFilePeek.mockClear()
    toastError.mockClear()
    rows = {
      [OLD.toLowerCase()]: row('doc-b', OLD, replaced),
      [CURRENT.toLowerCase()]: row('doc-c', CURRENT),
      'brandschutz.pdf': row('doc-x', 'Brandschutz.pdf'),
    }
    vi.stubGlobal('fetch', fetchMock)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  test('the peek says it is an older revision and names the current one', async () => {
    const user = userEvent.setup()
    render(<SourcePreviewChip citation={refTo(OLD)} />)

    await user.hover(await screen.findByRole('button', { name: /Preview source/ }))

    expect(await screen.findByText('Older revision. Current:')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: `Open the current revision: ${CURRENT}` })).toHaveTextContent(CURRENT)
  })

  test('the name opens the current revision beside the conversation, from the shelf it lives on', async () => {
    const user = userEvent.setup()
    render(<SourcePreviewChip citation={refTo(OLD)} />)
    await user.hover(await screen.findByRole('button', { name: /Preview source/ }))

    await user.click(await screen.findByRole('button', { name: `Open the current revision: ${CURRENT}` }))

    await waitFor(() => expect(open.openFilePeek).toHaveBeenCalledTimes(1))
    expect(open.openFilePeek).toHaveBeenCalledWith(
      expect.objectContaining({
        file: expect.objectContaining({ id: 'doc-c', filename: CURRENT }),
        source: 'project',
        projectId: 'project-1',
      })
    )
  })

  test('a current revision that is gone says so and opens nothing', async () => {
    const user = userEvent.setup()
    delete rows[CURRENT.toLowerCase()]
    render(<SourcePreviewChip citation={refTo(OLD)} />)
    await user.hover(await screen.findByRole('button', { name: /Preview source/ }))

    await user.click(await screen.findByRole('button', { name: `Open the current revision: ${CURRENT}` }))

    await waitFor(() => expect(toastError).toHaveBeenCalledWith('The current revision cannot be opened.'))
    expect(open.openFilePeek).not.toHaveBeenCalled()
  })

  test('a document nobody replaced shows no line', async () => {
    const user = userEvent.setup()
    render(<SourcePreviewChip citation={refTo('Brandschutz.pdf')} />)

    await user.hover(await screen.findByRole('button', { name: /Preview source/ }))

    expect(await screen.findByText('Open at this passage')).toBeInTheDocument()
    expect(screen.queryByText('Older revision. Current:')).toBeNull()
  })

  test('a newer revision the reader may not open is not in the row, so the peek names nothing', async () => {
    const user = userEvent.setup()
    rows[OLD.toLowerCase()] = row('doc-b', OLD, { fassung: null })
    render(<SourcePreviewChip citation={refTo(OLD)} />)

    await user.hover(await screen.findByRole('button', { name: /Preview source/ }))

    expect(await screen.findByText('Open at this passage')).toBeInTheDocument()
    expect(screen.queryByText('Older revision. Current:')).toBeNull()
    expect(screen.queryByText(CURRENT)).toBeNull()
  })
})
