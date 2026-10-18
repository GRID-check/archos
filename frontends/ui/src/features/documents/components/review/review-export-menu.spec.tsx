/**
 * „Protokoll exportieren" in the Prüfansicht: the choices reach the link, the
 * Fassung and proposal choices appear only where they mean something, the
 * file is saved under the server's name, and a refusal is a toast. „Im
 * Projekt ablegen" files the same export through the project's upload door,
 * into the document's folder, and the toast opens what it filed.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import userEvent from '@testing-library/user-event'

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() } }))
const push = vi.fn()
vi.mock('next/navigation', () => ({ useRouter: () => ({ push }) }))
vi.mock('@/lib/analytics/posthog', () => ({ capturePosthog: vi.fn() }))

import { toast } from 'sonner'
import { render, screen } from '@/test-utils'
import { captureDownloads, type StartedDownload } from '@/test-utils/downloads'
import { capturePosthog } from '@/lib/analytics/posthog'
import { ReviewExportMenu } from './review-export-menu'

const fetchMock = vi.fn()
let downloads: StartedDownload[] = []

beforeEach(() => {
  vi.clearAllMocks()
  downloads = captureDownloads()
  vi.stubGlobal('fetch', fetchMock)
  // jsdom has no object URLs; this file's own environment, so nothing else sees them.
  Object.assign(URL, { createObjectURL: vi.fn(() => 'blob:protokoll'), revokeObjectURL: vi.fn() })
  fetchMock.mockResolvedValue(
    new Response(new Blob(['%PDF']), {
      status: 200,
      headers: {
        'Content-Disposition': `attachment; filename="x.pdf"; filename*=UTF-8''${encodeURIComponent('Anmerkungen – Grundriss EG – Fassung 3.pdf')}`,
      },
    })
  )
})

afterEach(() => vi.unstubAllGlobals())

const open = async (props: Partial<Parameters<typeof ReviewExportMenu>[0]> = {}) => {
  const user = userEvent.setup()
  render(<ReviewExportMenu documentId="doc_1" hasFassungen={false} hasProposals={false} {...props} />)
  await user.click(screen.getByRole('button', { name: 'Export minutes' }))
  return user
}

describe('ReviewExportMenu', () => {
  it('downloads the open marks of the current Fassung by default, under the name the server gave', async () => {
    const user = await open()
    await user.click(await screen.findByRole('menuitem', { name: 'PDF' }))

    expect(fetchMock).toHaveBeenCalledWith('/api/documents/doc_1/annotations/export?format=pdf&scope=open&fassung=current')
    await vi.waitFor(() =>
      expect(downloads).toEqual([{ href: 'blob:protokoll', download: 'Anmerkungen – Grundriss EG – Fassung 3.pdf' }])
    )
  })

  it('counts a downloaded Protokoll as a report taken out of the app (the CSAT trigger), by kind and format only', async () => {
    const user = await open()
    await user.click(await screen.findByRole('menuitem', { name: 'Word (.docx)' }))

    await vi.waitFor(() => expect(capturePosthog).toHaveBeenCalledWith('report_exported', { kind: 'annotations', format: 'docx' }))
  })

  it('carries the scope, the Fassung and the proposals into the link, and stays open while choosing', async () => {
    const user = await open({ hasFassungen: true, hasProposals: true })
    await user.click(await screen.findByRole('menuitemradio', { name: 'Resolved ones too' }))
    await user.click(screen.getByRole('menuitemradio', { name: 'All revisions' }))
    await user.click(screen.getByRole('menuitemcheckbox', { name: 'Add Piloti’s proposals' }))
    await user.click(screen.getByRole('menuitem', { name: 'Word (.docx)' }))

    expect(fetchMock).toHaveBeenCalledWith(
      '/api/documents/doc_1/annotations/export?format=docx&scope=all&fassung=all&includeProposals=1'
    )
  })

  it('offers the Fassung only for the record: open marks come from every Fassung whatever it says', async () => {
    const user = await open({ hasFassungen: true })
    expect(await screen.findByRole('menuitemradio', { name: 'Open only' })).toBeInTheDocument()
    expect(screen.queryByRole('menuitemradio', { name: 'All revisions' })).toBeNull()
    await user.click(screen.getByRole('menuitemradio', { name: 'Resolved ones too' }))
    expect(await screen.findByRole('menuitemradio', { name: 'All revisions' })).toBeInTheDocument()
  })

  it('offers no Fassung or proposal choice where the document has neither', async () => {
    await open()
    expect(await screen.findByRole('menuitemradio', { name: 'Open only' })).toBeInTheDocument()
    expect(screen.queryByRole('menuitemradio', { name: 'All revisions' })).toBeNull()
    expect(screen.queryByRole('menuitemcheckbox', { name: 'Add Piloti’s proposals' })).toBeNull()
  })

  it('says why a PDF was refused, and points at Word and Markdown', async () => {
    fetchMock.mockResolvedValue(new Response('{}', { status: 422 }))
    const user = await open()
    await user.click(await screen.findByRole('menuitem', { name: 'PDF' }))

    await vi.waitFor(() => expect(toast.error).toHaveBeenCalledWith('Too long for a PDF. Export them as Word or Markdown.', {}))
    expect(downloads).toEqual([])
    expect(capturePosthog).not.toHaveBeenCalled()
  })
})

describe('filing the Protokoll in the project', () => {
  const FILING = { target: { projectId: 'proj_1', folderId: 'folder_plans' }, documentName: 'Grundriss EG.pdf' }

  /** The export's bytes, then the upload door's answer; what the upload received. */
  function serveFiling(upload: { status?: number; body: unknown }, exportStatus = 200) {
    const uploads: FormData[] = []
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url === '/api/documents/upload') {
        uploads.push(init?.body as FormData)
        return new Response(JSON.stringify(upload.body), { status: upload.status ?? 201 })
      }
      if (exportStatus !== 200 && url.includes('format=pdf')) return new Response('{}', { status: exportStatus })
      return new Response(new Blob(['%PDF']), { status: 200, headers: { 'Content-Type': 'application/pdf' } })
    })
    return uploads
  }

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-10-18T21:30:00.000Z')) // 23:30 in Vienna: still the 18th there
  })
  afterEach(() => vi.useRealTimers())

  it('files the export, with the menu’s choices, into the document’s folder under „Minutes – <name> – <day>“, and opens it', async () => {
    const uploads = serveFiling({ body: { documentId: 'doc_protokoll', status: 'pending', filename: 'x' } })
    const user = await open({ filing: FILING })
    await user.click(await screen.findByRole('menuitemradio', { name: 'Resolved ones too' }))
    await user.click(screen.getByRole('menuitem', { name: 'File in the project' }))

    await vi.waitFor(() => expect(uploads).toHaveLength(1))
    expect(fetchMock).toHaveBeenCalledWith('/api/documents/doc_1/annotations/export?format=pdf&scope=all&fassung=current')
    const form = uploads[0] as FormData
    expect((form.get('file') as File).name).toBe('Minutes – Grundriss EG – 2026-10-18.pdf')
    expect(form.get('projectId')).toBe('proj_1')
    expect(form.get('folderId')).toBe('folder_plans')
    expect(downloads).toEqual([])

    await vi.waitFor(() => expect(toast.success).toHaveBeenCalled())
    const [message, options] = vi.mocked(toast.success).mock.calls[0] ?? []
    expect(message).toBe('Filed as “Minutes – Grundriss EG – 2026-10-18.pdf”')
    const action = options?.action as { onClick: () => void } | undefined
    action?.onClick()
    expect(push).toHaveBeenCalledWith('/app/projects/proj_1/files?doc=doc_protokoll')
  })

  it('says a second filing the same day became a new revision of the first, and the same bytes again wrote nothing', async () => {
    serveFiling({ body: { documentId: 'doc_protokoll' } })
    const user = await open({ filing: FILING })
    await user.click(await screen.findByRole('menuitem', { name: 'File in the project' }))
    await vi.waitFor(() => expect(toast.success).toHaveBeenCalledTimes(1))

    await user.click(screen.getByRole('button', { name: 'Export minutes' }))
    await user.click(await screen.findByRole('menuitem', { name: 'File in the project' }))
    await vi.waitFor(() => expect(toast.success).toHaveBeenCalledTimes(2))
    expect(vi.mocked(toast.success).mock.calls[1]?.[0]).toBe('Filed as a new revision of “Minutes – Grundriss EG – 2026-10-18.pdf”')

    serveFiling({ body: { documentId: 'doc_protokoll', unchanged: true } })
    await user.click(screen.getByRole('button', { name: 'Export minutes' }))
    await user.click(await screen.findByRole('menuitem', { name: 'File in the project' }))
    await vi.waitFor(() => expect(toast.success).toHaveBeenCalledTimes(3))
    expect(vi.mocked(toast.success).mock.calls[2]?.[0]).toBe('“Minutes – Grundriss EG – 2026-10-18.pdf” is already in the project as it is.')
  })

  it('files a Protokoll too long for a PDF as Word', async () => {
    const uploads = serveFiling({ body: { documentId: 'doc_protokoll' } }, 422)
    const user = await open({ filing: FILING })
    await user.click(await screen.findByRole('menuitem', { name: 'File in the project' }))

    await vi.waitFor(() => expect(uploads).toHaveLength(1))
    expect(fetchMock).toHaveBeenCalledWith('/api/documents/doc_1/annotations/export?format=docx&scope=open&fassung=current')
    expect(((uploads[0] as FormData).get('file') as File).name).toBe('Minutes – Grundriss EG – 2026-10-18.docx')
  })

  it('says when another document holds the name, and files nothing', async () => {
    serveFiling({ status: 409, body: { error: 'taken', code: 'CONFLICT', details: { reason: 'name_taken' } } })
    const user = await open({ filing: FILING })
    await user.click(await screen.findByRole('menuitem', { name: 'File in the project' }))

    await vi.waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith(
        'Another document in the project is already called “Minutes – Grundriss EG – 2026-10-18”. The minutes were not filed.',
        {}
      )
    )
    expect(toast.success).not.toHaveBeenCalled()
  })

  it('is not offered where the document is no project’s, or the reader may not file there', async () => {
    await open()
    expect(await screen.findByRole('menuitem', { name: 'PDF' })).toBeInTheDocument()
    expect(screen.queryByRole('menuitem', { name: 'File in the project' })).toBeNull()
  })
})
