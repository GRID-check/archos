/**
 * The preview of an E-Mail-Verlauf and of a file a mail brought (D16, D36):
 * a thread document's rail opens on its „E-Mails“ tab, a link with
 * `?mailEntry=` lands on that mail; a document whose newest Fassung came with
 * a mail says which under its header; any other document asks nothing of the
 * mail routes and shows neither.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const params = { current: new URLSearchParams() }
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
  usePathname: () => '/app/projects/proj-1/files',
  useSearchParams: () => params.current,
}))

import { render, screen, waitFor, within } from '@/test-utils'
import { MAIL_THREAD_VARIANTS, origin, versions } from '@/app/dev/mail-thread/fixtures'
import { FilePreviewPane } from './file-preview-pane'

const thread = MAIL_THREAD_VARIANTS['three-messages'].view

const baseFile = {
  displayName: null,
  fileSize: 4096,
  status: 'ready',
  folderId: null,
  createdAt: '2026-10-01T00:00:00.000Z',
  errorMessage: null,
  summary: null,
  pageCount: null,
  chunkCount: null,
  contentTypes: null,
  topics: null,
  capture: null,
}
const threadFile = { ...baseFile, id: thread.documentId, filename: 'Stellplatznachweis.md', contentType: 'text/markdown', tags: ['correspondence'] }
const attachmentFile = { ...baseFile, id: 'doc-att', filename: 'S-101_C.pdf', contentType: 'application/pdf', tags: null }
const plainFile = { ...baseFile, id: 'doc-plain', filename: 'Baubeschreibung.docx', contentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', tags: null }

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

let fetchMock: ReturnType<typeof vi.fn>
beforeEach(() => {
  Element.prototype.scrollIntoView = vi.fn()
  params.current = new URLSearchParams()
  fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input)
    if (url.includes('/mail-threads?')) return json({ items: url.includes(thread.documentId) ? [thread] : [], nextCursor: null })
    if (url.includes(`/mail-threads/${thread.id}`)) return json(thread)
    if (url === `/api/documents/${thread.documentId}/versions`) return json({ documentId: thread.documentId, lifecycle: 'active', publishedVersionId: null, versions: versions(3) })
    if (url === '/api/documents/doc-att/versions') {
      return json({ documentId: 'doc-att', lifecycle: 'active', publishedVersionId: null, versions: [{ ...versions(1)[0], documentId: 'doc-att', mailOrigins: [origin()] }] })
    }
    return json({ error: 'not here' }, 404)
  })
  vi.stubGlobal('fetch', fetchMock)
})
afterEach(() => vi.unstubAllGlobals())

describe('FilePreviewPane › mail', () => {
  it('opens a thread document on its „E-Mails“ tab', async () => {
    render(<FilePreviewPane file={threadFile} projectId="proj-1" viewerUserId="user_x" />)
    const tab = await screen.findByTestId('file-rail-tab-mail')
    expect(tab).toHaveAttribute('data-state', 'active')
    expect(tab).toHaveTextContent('Mails')
    expect(await screen.findAllByTestId('mail-thread-entry')).toHaveLength(3)
    expect(screen.getByTestId('file-rail-tab-details')).toHaveAttribute('data-state', 'inactive')
    expect(screen.queryByTestId('mail-provenance-row')).toBeNull()
  })

  it('lands a `?mailEntry=` link on its mail', async () => {
    const target = thread.entries[0]
    params.current = new URLSearchParams({ doc: thread.documentId, mailEntry: target.id })
    render(<FilePreviewPane file={threadFile} projectId="proj-1" />)
    await waitFor(() => expect(screen.getAllByTestId('mail-thread-entry').find((row) => row.dataset.focused)?.dataset.entryId).toBe(target.id))
  })

  it('says under the header which mail brought the file, and links into its thread', async () => {
    render(<FilePreviewPane file={attachmentFile} projectId="proj-1" />)
    const row = await screen.findByTestId('mail-provenance-row')
    expect(row).toHaveTextContent('Came with the mail from DI Petra Weber')
    expect(within(row).getByTestId('mail-origin-trust')).toHaveTextContent('Domain verified: statik-weber.at')
    expect(within(row).getByTestId('mail-origin-open')).toBeInTheDocument()
    expect(screen.queryByTestId('file-rail-tab-mail')).toBeNull()
  })

  it('asks the mail routes nothing for a document that cannot be a thread', async () => {
    render(<FilePreviewPane file={plainFile} projectId="proj-1" />)
    await waitFor(() => expect(fetchMock).toHaveBeenCalled())
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes('/mail-threads'))).toBe(false)
    expect(screen.queryByTestId('file-rail-tab-mail')).toBeNull()
    expect(screen.queryByTestId('mail-provenance-row')).toBeNull()
  })
})
