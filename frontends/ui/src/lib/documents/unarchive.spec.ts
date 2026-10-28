/**
 * @vitest-environment node
 */
/** The reverse of archiving (ADR-0131 rule 7): back in the working set, and read into the index again. */
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('server-only', () => ({}))
vi.mock('./access', () => ({ getAccessibleDocument: vi.fn() }))
vi.mock('@/lib/authz/projects', () => ({ requireProjectAccess: vi.fn() }))
vi.mock('@/lib/audit/service', () => ({ recordAuditEvent: vi.fn() }))
vi.mock('./folder-path', () => ({ resolveDocumentFolderPath: vi.fn().mockResolvedValue('Pläne') }))
vi.mock('./lifecycle', () => ({ redispatchPublishedVersion: vi.fn() }))
vi.mock('./repository', () => ({ markDocumentIngestFailed: vi.fn() }))
vi.mock('./document-dispatch', () => ({
  dispatchDocument: vi.fn(),
}))
vi.mock('./ingest-dispatch', () => ({
  INGEST_DISPATCH_FAILED_MESSAGE: 'failed',
}))
vi.mock('./shelf-live', () => ({ publishShelfChanged: vi.fn() }))
vi.mock('./version-repository', () => ({ setDocumentLifecycle: vi.fn() }))

import type { AuthorizedSession } from '@/lib/auth/types'
import { recordAuditEvent } from '@/lib/audit/service'
import { getAccessibleDocument } from './access'
import { dispatchDocument } from './document-dispatch'
import { unarchiveDocument } from './unarchive'
import { setDocumentLifecycle } from './version-repository'

const session = { userId: 'u1', organizationId: 'org-1', email: 'a@b.test' } as AuthorizedSession
const archived = {
  id: 'd1',
  projectId: 'p1',
  folderId: null,
  scope: 'project',
  lifecycle: 'archived',
  status: 'stored',
  authoredBy: 'user',
  filename: 'Plan.pdf',
  storageKey: 'k',
  storageBucket: 'b',
  collectionName: 'proj_abc',
}

beforeEach(() => vi.clearAllMocks())

describe('unarchiveDocument', () => {
  it('makes the document active and dispatches its bytes again', async () => {
    vi.mocked(getAccessibleDocument).mockResolvedValue(archived as never)
    vi.mocked(dispatchDocument).mockResolvedValue({ jobId: 'j1', status: 'pending' })

    const result = await unarchiveDocument(session, 'd1')

    expect(setDocumentLifecycle).toHaveBeenCalledWith('d1', 'org-1', 'active')
    expect(dispatchDocument).toHaveBeenCalledWith(expect.objectContaining({ documentId: 'd1', collectionName: 'proj_abc' }))
    expect(recordAuditEvent).toHaveBeenCalledWith(expect.objectContaining({ action: 'document.unarchived' }))
    expect(result).toEqual({ documentId: 'd1', lifecycle: 'active', ingest: 'queued' })
  })

  it('leaves a held file for its review', async () => {
    vi.mocked(getAccessibleDocument).mockResolvedValue({ ...archived, status: 'quarantined' } as never)
    expect((await unarchiveDocument(session, 'd1')).ingest).toBe('held')
    expect(dispatchDocument).not.toHaveBeenCalled()
  })

  it('answers an active document as it is', async () => {
    vi.mocked(getAccessibleDocument).mockResolvedValue({ ...archived, lifecycle: 'active' } as never)
    expect((await unarchiveDocument(session, 'd1')).ingest).toBe('unchanged')
    expect(setDocumentLifecycle).not.toHaveBeenCalled()
  })
})
