/**
 * @vitest-environment node
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('server-only', () => ({}))
vi.mock('@/lib/db/tenant-context', () => ({
  withTenant: vi.fn(async (_scope: unknown, fn: () => unknown) => await fn()),
  withPlatformAccess: vi.fn(async (_reason: string, fn: () => unknown) => await fn()),
}))
vi.mock('@/lib/documents/shelf-authz', () => ({ requireShelfWrite: vi.fn() }))
vi.mock('@/lib/authz/folder-access', () => ({ requireFolderWrite: vi.fn() }))
vi.mock('@/lib/documents/folder-path', () => ({ resolveShelfFolderPath: vi.fn(async () => 'E-Mail-Import/Büro 2019') }))
vi.mock('@/lib/inbox/service', () => ({ emitInboxItems: vi.fn() }))
vi.mock('@/lib/jobs-queue/repository', () => ({ findOpenJobId: vi.fn() }))
vi.mock('@/lib/jobs-queue/enqueue', () => ({ enqueueJob: vi.fn(async () => ({ jobId: 'job_next' })) }))
vi.mock('@/lib/auth/pinned-session', () => ({
  resolvePinnedRequesterSession: vi.fn(async () => ({
    userId: 'user_anna',
    email: '',
    organizationMembershipId: 'om_1',
    role: 'member',
    permissions: [],
    featureFlags: null,
  })),
}))
vi.mock('@/lib/projects/folder-service', () => ({
  findRootProjectFolderByName: vi.fn(async () => null),
  getOrCreateProjectFolderByName: vi.fn(async () => ({ id: 'folder_root', name: 'E-Mail-Import' })),
}))
vi.mock('./staging', () => ({ archiveUrlForBackend: vi.fn(async () => 'http://seaweedfs/presigned') }))
vi.mock('./service', () => ({ discardStaging: vi.fn() }))
vi.mock('./archive-client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./archive-client')>()
  return { ...actual, readArchivePage: vi.fn() }
})
vi.mock('./filing', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./filing')>()
  return {
    ...actual,
    createFolderWithFreeName: vi.fn(async () => ({ id: 'folder_archive', name: 'Büro 2019' })),
    filingContext: vi.fn((input: object) => ({ ...input, folders: new Map() })),
    fileMail: vi.fn(async () => ({
      folderName: 'm',
      filesFiled: 2,
      filesSkipped: 1,
      skipped: [{ mail: 'm', file: 'x.exe', reason: 'type' }],
      nameStops: [],
      threadsCreated: 1,
      threadsAppended: 0,
      alreadyInProject: 0,
    })),
    recordNameStops: vi.fn(async () => {}),
  }
})
const batchStore = vi.hoisted(() => new Map<string, { sealed: boolean; documents: number }>())
vi.mock('@/lib/upload-batches/service', () => ({
  UPLOAD_BATCH_MAX_FILES: 10_000,
  findJobUploadBatch: vi.fn(async (_org: string, id: string) => {
    const batch = batchStore.get(id)
    if (!batch) return { status: 'missing' }
    return batch.sealed ? { status: 'sealed' } : { status: 'open', documents: batch.documents }
  }),
  openUploadBatch: vi.fn(async (_session: unknown, input: { id: string }) => {
    batchStore.set(input.id, { sealed: false, documents: 0 })
  }),
  sealJobUploadBatch: vi.fn(async (_org: string, id: string) => {
    const batch = batchStore.get(id)
    if (batch) batch.sealed = true
  }),
}))
vi.mock('./repository', () => ({
  findMailImport: vi.fn(),
  updateMailImport: vi.fn(),
  advanceMailImport: vi.fn(async () => true),
  recordSkippedFiles: vi.fn(async () => true),
  listStaleOpenImports: vi.fn(async () => []),
}))
vi.mock('@/lib/mail-thread/archive', () => ({
  renderPendingThreads: vi.fn(async () => ({ rendered: 0, waiting: 0, skipped: [], quotaFull: false })),
}))
vi.mock('@/lib/mail-thread/append', () => ({ RENDER_LEASE_RETRY_MS: 15_000 }))
vi.mock('@/lib/mail-thread/thread-locale', () => ({ newThreadLocaleFor: vi.fn(async () => 'en') }))

import type { AuthorizedSession } from '@/lib/auth/types'
import type { MailImport } from '@/lib/db/schema'
import { emitInboxItems } from '@/lib/inbox/service'
import { ForbiddenError, NotFoundError } from '@/lib/api/errors'
import { requireFolderWrite } from '@/lib/authz/folder-access'
import { folderReadOnlyError } from '@/lib/authz/folder-access-rule'
import { findRootProjectFolderByName } from '@/lib/projects/folder-service'
import { resolvePinnedRequesterSession } from '@/lib/auth/pinned-session'
import { resolveShelfFolderPath } from '@/lib/documents/folder-path'
import { requireShelfWrite } from '@/lib/documents/shelf-authz'
import { enqueueJob } from '@/lib/jobs-queue/enqueue'
import { findOpenJobId } from '@/lib/jobs-queue/repository'
import { readArchivePage, UnreadableArchiveError, type ArchivePage } from './archive-client'
import { renderPendingThreads } from '@/lib/mail-thread/archive'
import { ARCHIVE_THREAD_RENDER_EFFECTS } from '@/lib/inbound-mail/batch-effects'
import { openUploadBatch, sealJobUploadBatch } from '@/lib/upload-batches/service'
import {
  createFolderWithFreeName,
  fileMail,
  recordNameStops,
  filingContext,
  ImportMovedOnError,
  MailImportQuotaError,
  SliceBudgetSpentError,
  ThreadBusyError,
} from './filing'
import { runMailImportSlice, sweepStaleMailImports } from './job'
import * as repository from './repository'
import { discardStaging } from './service'
import { importBatchId } from './upload-batch'

const session = { userId: 'user_anna', organizationId: 'org_1' } as AuthorizedSession

function row(overrides: Partial<MailImport> = {}): MailImport {
  return {
    id: '11111111-1111-4111-8111-111111111111',
    organizationId: 'org_1',
    projectId: '22222222-2222-4222-8222-222222222222',
    userId: 'user_anna',
    userEmail: null,
    filename: 'Büro 2019.pst',
    sizeBytes: 1000,
    status: 'importing',
    stagingBucket: 'b',
    stagingKey: 'k',
    uploadId: null,
    stagingDeletedAt: null,
    rootFolderId: 'folder_archive',
    totalItems: 2,
    nextPosition: 0,
    inflightPosition: null,
    inflightFolderId: null,
    mailsFiled: 0,
    filesFiled: 0,
    itemsSkipped: 0,
    filesSkipped: 0,
    threadsCreated: 0,
    threadsAppended: 0,
    alreadyInProject: 0,
    skippedSamples: [],
    failureStreak: 0,
    errorCode: null,
    lastError: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    completedAt: null,
    ...overrides,
  }
}

const payload = {
  importId: row().id,
  projectId: row().projectId,
  requester: { userId: 'user_anna', email: '', organizationMembershipId: 'om_1', role: 'member', permissions: [] },
}

const mail = {
  kind: 'mail' as const,
  position: 0,
  message_class: 'IPM.Note',
  folder_path: ['Posteingang'],
  subject: 'Plan',
  sender: null,
  to: [],
  cc: [],
  bcc: [],
  sent_at: null,
  received_at: null,
  message_id: null,
  in_reply_to: null,
  references: null,
  conversation_index: null,
  body: { text: '', source: 'none', truncated: false },
  attachments: [],
}
const contact = { kind: 'other' as const, position: 1, message_class: 'IPM.Contact', folder_path: ['Kontakte'] }

function page(messages: ArchivePage['messages'], next: number | null, total = 2): ArchivePage {
  return { total, next_position: next, messages }
}

beforeEach(() => {
  vi.clearAllMocks()
  batchStore.clear()
  vi.mocked(repository.updateMailImport).mockImplementation(async (_org, _id, _from, patch) => ({ ...row(), ...patch }))
})

describe('runMailImportSlice', () => {
  it('files mails, counts other items as skipped, moves the cursor past each, and completes', async () => {
    vi.mocked(repository.findMailImport).mockResolvedValueOnce(row())
    vi.mocked(readArchivePage).mockResolvedValueOnce(page([mail, contact], null))

    const result = await runMailImportSlice(session, payload, 'org_1')

    expect(result.done).toBe(true)
    expect(fileMail).toHaveBeenCalledOnce()
    expect(repository.advanceMailImport).toHaveBeenNthCalledWith(1, 'org_1', payload.importId, 0, expect.objectContaining({
      to: 1, mailsFiled: 1, filesFiled: 2, filesSkipped: 1, threadsCreated: 1, threadsAppended: 0, alreadyInProject: 0,
    }))
    // A contact is counted, not sampled: a calendar walked first would fill every sample.
    expect(repository.advanceMailImport).toHaveBeenNthCalledWith(2, 'org_1', payload.importId, 1, expect.objectContaining({
      to: 2, itemsSkipped: 1,
      skippedSamples: [{ mail: 'm', file: 'x.exe', reason: 'type' }],
    }))
    expect(repository.updateMailImport).toHaveBeenCalledWith('org_1', payload.importId, ['queued', 'importing'], expect.objectContaining({ status: 'completed' }))
    expect(discardStaging).toHaveBeenCalledOnce()
    expect(emitInboxItems).toHaveBeenCalledWith([expect.objectContaining({ type: 'mail_import.completed', anchorId: 'folder_archive' })])
  })

  it('stops quietly when another slice already moved the cursor', async () => {
    vi.mocked(repository.findMailImport).mockResolvedValueOnce(row())
    vi.mocked(readArchivePage).mockResolvedValueOnce(page([mail, contact], null))
    vi.mocked(repository.advanceMailImport).mockResolvedValueOnce(false)

    expect((await runMailImportSlice(session, payload, 'org_1')).done).toBe(true)
    expect(repository.advanceMailImport).toHaveBeenCalledOnce()
    expect(emitInboxItems).not.toHaveBeenCalled()
    // The other slice counted this mail's name stops; this one does not again.
    expect(recordNameStops).not.toHaveBeenCalled()
  })

  it('counts a mail’s name stops once its cursor moved', async () => {
    vi.mocked(repository.findMailImport).mockResolvedValueOnce(row())
    vi.mocked(readArchivePage).mockResolvedValueOnce(page([mail], null))

    await runMailImportSlice(session, payload, 'org_1')

    expect(recordNameStops).toHaveBeenCalledOnce()
    expect(vi.mocked(recordNameStops).mock.invocationCallOrder[0]).toBeGreaterThan(
      vi.mocked(repository.advanceMailImport).mock.invocationCallOrder[0] ?? Infinity
    )
  })

  it('does nothing for an import that already ended', async () => {
    vi.mocked(repository.findMailImport).mockResolvedValueOnce(row({ status: 'cancelled', completedAt: new Date() }))
    expect((await runMailImportSlice(session, payload, 'org_1')).done).toBe(true)
    expect(readArchivePage).not.toHaveBeenCalled()
  })

  it('ends the import at once when the file is not an archive', async () => {
    vi.mocked(repository.findMailImport).mockResolvedValueOnce(row())
    vi.mocked(readArchivePage).mockRejectedValueOnce(new UnreadableArchiveError('not a readable Outlook archive'))

    expect((await runMailImportSlice(session, payload, 'org_1')).done).toBe(true)
    expect(repository.updateMailImport).toHaveBeenCalledWith('org_1', payload.importId, ['queued', 'importing'], expect.objectContaining({
      status: 'failed', errorCode: 'unreadable', lastError: expect.stringMatching(/could not be read/),
    }))
    expect(emitInboxItems).toHaveBeenCalledWith([expect.objectContaining({ type: 'mail_import.failed' })])
  })

  it('ends the import when the quota is full', async () => {
    vi.mocked(repository.findMailImport).mockResolvedValueOnce(row())
    vi.mocked(readArchivePage).mockResolvedValueOnce(page([mail], null, 1))
    vi.mocked(fileMail).mockRejectedValueOnce(new MailImportQuotaError())

    await runMailImportSlice(session, payload, 'org_1')
    expect(repository.updateMailImport).toHaveBeenCalledWith('org_1', payload.importId, ['queued', 'importing'], expect.objectContaining({
      status: 'failed', errorCode: 'quota',
    }))
  })

  it('hands the import on to a fresh job after a passing failure, waiting out the backoff', async () => {
    vi.mocked(repository.findMailImport).mockResolvedValue(row({ failureStreak: 1 }))
    vi.mocked(readArchivePage).mockRejectedValueOnce(new Error('the archive reader answered 502'))
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const before = Date.now()

    expect((await runMailImportSlice(session, payload, 'org_1')).done).toBe(true)
    expect(repository.updateMailImport).toHaveBeenCalledWith('org_1', payload.importId, ['queued', 'importing'], {
      failureStreak: 2,
      lastError: expect.stringMatching(/502/),
    })
    const queued = vi.mocked(enqueueJob).mock.calls[0][0]
    expect(queued).toMatchObject({ kind: 'mail_import', organizationId: 'org_1', payload })
    // The second failure in a row waits the second backoff, five minutes.
    expect(queued.notBefore!.getTime()).toBeGreaterThanOrEqual(before + 5 * 60_000)
    expect(emitInboxItems).not.toHaveBeenCalled()
    vi.mocked(repository.findMailImport).mockReset()
  })

  it('ends the import only when the streak has run through every backoff without a mail filed', async () => {
    vi.mocked(repository.findMailImport).mockResolvedValue(row({ failureStreak: 6 }))
    vi.mocked(readArchivePage).mockRejectedValueOnce(new Error('the archive reader answered 502'))
    vi.spyOn(console, 'warn').mockImplementation(() => {})

    await runMailImportSlice(session, payload, 'org_1')
    expect(enqueueJob).not.toHaveBeenCalled()
    expect(repository.updateMailImport).toHaveBeenCalledWith('org_1', payload.importId, ['queued', 'importing'], expect.objectContaining({
      status: 'failed', errorCode: 'stopped', lastError: expect.stringMatching(/Repeated errors.*502/),
    }))
    vi.mocked(repository.findMailImport).mockReset()
  })

  it('treats an outage behind the access check as passing, and only a refusal as lost access', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.mocked(repository.findMailImport).mockResolvedValue(row())
    vi.mocked(requireShelfWrite).mockRejectedValueOnce(new Error('connect ECONNREFUSED'))
    await runMailImportSlice(session, payload, 'org_1')
    expect(enqueueJob).toHaveBeenCalledOnce()

    vi.mocked(requireShelfWrite).mockRejectedValueOnce(new ForbiddenError())
    await runMailImportSlice(session, payload, 'org_1')
    expect(repository.updateMailImport).toHaveBeenCalledWith('org_1', payload.importId, ['queued', 'importing'], expect.objectContaining({
      status: 'failed', errorCode: 'access',
    }))
    vi.mocked(repository.findMailImport).mockReset()
  })

  it('stops a slice whose time ran out inside a mail without moving the cursor, and resumes later', async () => {
    vi.mocked(repository.findMailImport).mockResolvedValueOnce(row())
    vi.mocked(readArchivePage).mockResolvedValueOnce(page([mail], null, 1))
    vi.mocked(fileMail).mockRejectedValueOnce(new SliceBudgetSpentError())

    expect((await runMailImportSlice(session, payload, 'org_1')).done).toBe(false)
    expect(repository.advanceMailImport).not.toHaveBeenCalled()
  })

  it('ends a slice quietly when the import moved on under it', async () => {
    vi.mocked(repository.findMailImport).mockResolvedValueOnce(row())
    vi.mocked(readArchivePage).mockResolvedValueOnce(page([mail], null, 1))
    vi.mocked(fileMail).mockRejectedValueOnce(new ImportMovedOnError())

    expect((await runMailImportSlice(session, payload, 'org_1')).done).toBe(true)
    expect(enqueueJob).not.toHaveBeenCalled()
    expect(emitInboxItems).not.toHaveBeenCalled()
  })

  it('skips a damaged item, sampled by its number', async () => {
    vi.mocked(repository.findMailImport).mockResolvedValueOnce(row({ totalItems: 1 }))
    vi.mocked(readArchivePage).mockResolvedValueOnce(
      page([{ kind: 'unreadable', position: 0, folder_path: [], detail: 'message 0 is damaged' }], null, 1),
    )

    await runMailImportSlice(session, payload, 'org_1')
    expect(fileMail).not.toHaveBeenCalled()
    expect(repository.advanceMailImport).toHaveBeenCalledWith('org_1', payload.importId, 0, expect.objectContaining({
      itemsSkipped: 1, skippedSamples: [{ mail: '#1', file: null, reason: 'unreadable' }],
    }))
  })

  it('ends the import with a reason when the person who started it left', async () => {
    vi.mocked(repository.findMailImport).mockResolvedValueOnce(row())
    await runMailImportSlice(null, payload, 'org_1')
    expect(repository.updateMailImport).toHaveBeenCalledWith('org_1', payload.importId, ['queued', 'importing'], expect.objectContaining({
      status: 'failed', errorCode: 'requester_left',
    }))
  })

  it('makes the archive folder once and remembers it', async () => {
    const queued = row({ status: 'queued', rootFolderId: null, totalItems: null })
    vi.mocked(repository.findMailImport).mockResolvedValueOnce(queued)
    vi.mocked(repository.updateMailImport).mockResolvedValueOnce({ ...queued, status: 'importing' })
    vi.mocked(readArchivePage).mockResolvedValueOnce(page([], null, 0))

    await runMailImportSlice(session, payload, 'org_1')
    expect(repository.updateMailImport).toHaveBeenCalledWith('org_1', payload.importId, ['queued'], { status: 'importing' })
    expect(repository.updateMailImport).toHaveBeenCalledWith('org_1', payload.importId, ['importing'], { rootFolderId: 'folder_archive' })
    // A root that did not exist is judged at the project root, then once more as the folder that now exists.
    expect(requireFolderWrite).toHaveBeenCalledWith(session, payload.projectId, [null])
    expect(requireFolderWrite).toHaveBeenCalledWith(session, payload.projectId, ['folder_root'])
  })

  it('ends the import at once as lost access when the existing E-Mail-Import folder is read-only or hidden for the person', async () => {
    const queued = row({ status: 'queued', rootFolderId: null, totalItems: null })
    vi.mocked(findRootProjectFolderByName).mockResolvedValue({ id: 'folder_root_restricted', name: 'E-Mail-Import' } as never)

    for (const refusal of [folderReadOnlyError(), new NotFoundError('Folder not found')]) {
      vi.mocked(repository.findMailImport).mockResolvedValueOnce(queued)
      vi.mocked(repository.updateMailImport).mockResolvedValueOnce({ ...queued, status: 'importing' })
      vi.mocked(requireFolderWrite).mockRejectedValueOnce(refusal)

      expect((await runMailImportSlice(session, payload, 'org_1')).done).toBe(true)
      expect(requireFolderWrite).toHaveBeenLastCalledWith(session, payload.projectId, ['folder_root_restricted'])
      expect(repository.updateMailImport).toHaveBeenLastCalledWith('org_1', payload.importId, ['queued', 'importing'], expect.objectContaining({
        status: 'failed', errorCode: 'access',
      }))
    }
    expect(createFolderWithFreeName).not.toHaveBeenCalled()
    expect(enqueueJob).not.toHaveBeenCalled()
    vi.mocked(findRootProjectFolderByName).mockReset()
  })

  it('checks write on the archive folder every slice, and ends the import when it turned read-only', async () => {
    vi.mocked(repository.findMailImport).mockResolvedValueOnce(row())
    vi.mocked(requireFolderWrite).mockRejectedValueOnce(folderReadOnlyError())

    await runMailImportSlice(session, payload, 'org_1')
    expect(requireFolderWrite).toHaveBeenCalledWith(session, payload.projectId, ['folder_archive'])
    expect(readArchivePage).not.toHaveBeenCalled()
    expect(repository.updateMailImport).toHaveBeenCalledWith('org_1', payload.importId, ['queued', 'importing'], expect.objectContaining({
      status: 'failed', errorCode: 'access',
    }))
    expect(enqueueJob).not.toHaveBeenCalled()
  })
})

describe('runMailImportSlice, E-Mail-Verläufe (D33)', () => {
  const rendered = (result: Partial<Awaited<ReturnType<typeof renderPendingThreads>>> = {}) => ({
    rendered: 0,
    waiting: 0,
    skipped: [],
    quotaFull: false,
    ...result,
  })

  it('renders each Verlauf the slice wrote into once, after its last mail, and only then completes', async () => {
    vi.mocked(repository.findMailImport).mockResolvedValueOnce(row())
    vi.mocked(readArchivePage).mockResolvedValueOnce(page([mail, { ...mail, position: 1 }], null))

    expect((await runMailImportSlice(session, payload, 'org_1')).done).toBe(true)
    expect(fileMail).toHaveBeenCalledTimes(2)
    expect(renderPendingThreads).toHaveBeenCalledOnce()
    const renderedAt = vi.mocked(renderPendingThreads).mock.invocationCallOrder[0]
    expect(renderedAt).toBeGreaterThan(vi.mocked(fileMail).mock.invocationCallOrder[1])
    const completedAt = vi.mocked(repository.updateMailImport).mock.calls.findIndex(([, , , patch]) => patch.status === 'completed')
    expect(vi.mocked(repository.updateMailImport).mock.invocationCallOrder[completedAt]).toBeGreaterThan(renderedAt)
    // The Verläufe' words are the starter's locale.
    expect(vi.mocked(filingContext).mock.calls[0][0]).toMatchObject({ locale: 'en' })
  })

  it('counts the Verläufe a mail opened or joined and a text the project already held as its cursor moves', async () => {
    vi.mocked(repository.findMailImport).mockResolvedValueOnce(row())
    vi.mocked(readArchivePage).mockResolvedValueOnce(page([mail, { ...mail, position: 1 }], null))
    vi.mocked(fileMail)
      .mockResolvedValueOnce({ folderName: 'a', filesFiled: 0, filesSkipped: 0, skipped: [], nameStops: [], threadsCreated: 0, threadsAppended: 1, alreadyInProject: 0 })
      .mockResolvedValueOnce({ folderName: 'b', filesFiled: 1, filesSkipped: 0, skipped: [], nameStops: [], threadsCreated: 0, threadsAppended: 0, alreadyInProject: 1 })

    await runMailImportSlice(session, payload, 'org_1')
    expect(repository.advanceMailImport).toHaveBeenNthCalledWith(1, 'org_1', payload.importId, 0, expect.objectContaining({ threadsAppended: 1, alreadyInProject: 0 }))
    expect(repository.advanceMailImport).toHaveBeenNthCalledWith(2, 'org_1', payload.importId, 1, expect.objectContaining({ threadsAppended: 0, alreadyInProject: 1 }))
  })

  it('does not complete while a Verlauf still owes a Fassung: it comes back shortly, counting no failure', async () => {
    vi.mocked(repository.findMailImport).mockResolvedValueOnce(row())
    vi.mocked(readArchivePage).mockResolvedValueOnce(page([mail], null, 1))
    vi.mocked(renderPendingThreads).mockResolvedValueOnce(rendered({ rendered: 2, waiting: 1 }))
    const before = Date.now()

    const result = await runMailImportSlice(session, payload, 'org_1')
    expect(result.done).toBe(false)
    expect(result.notBefore!.getTime()).toBeGreaterThanOrEqual(before + 15_000)
    expect(repository.updateMailImport).not.toHaveBeenCalledWith('org_1', payload.importId, expect.anything(), expect.objectContaining({ status: 'completed' }))
    expect(repository.updateMailImport).not.toHaveBeenCalledWith('org_1', payload.importId, expect.anything(), expect.objectContaining({ failureStreak: expect.any(Number) }))
    expect(enqueueJob).not.toHaveBeenCalled()
  })

  it('ends the slice when a mail’s Verlauf is another filing’s, renders what it wrote, and comes back without a failure', async () => {
    vi.mocked(repository.findMailImport).mockResolvedValueOnce(row())
    vi.mocked(readArchivePage).mockResolvedValueOnce(page([mail], null, 1))
    vi.mocked(fileMail).mockRejectedValueOnce(new ThreadBusyError())

    const result = await runMailImportSlice(session, payload, 'org_1')
    expect(result).toMatchObject({ done: false, notBefore: expect.any(Date) })
    expect(repository.advanceMailImport).not.toHaveBeenCalled()
    expect(renderPendingThreads).toHaveBeenCalledOnce()
    expect(enqueueJob).not.toHaveBeenCalled()
  })

  it('renders what a slice wrote before a passing failure, then hands the import on', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.mocked(repository.findMailImport).mockResolvedValue(row())
    vi.mocked(readArchivePage).mockResolvedValueOnce(page([mail, { ...mail, position: 1 }], null))
    vi.mocked(fileMail).mockResolvedValueOnce({ folderName: 'a', filesFiled: 0, filesSkipped: 0, skipped: [], nameStops: [], threadsCreated: 1, threadsAppended: 0, alreadyInProject: 0 })
    vi.mocked(fileMail).mockRejectedValueOnce(new Error('the archive reader answered 502'))

    await runMailImportSlice(session, payload, 'org_1')
    expect(renderPendingThreads).toHaveBeenCalledOnce()
    expect(enqueueJob).toHaveBeenCalledOnce()
    vi.mocked(repository.findMailImport).mockReset()
  })

  it('still renders what was written when the import was cancelled under the slice', async () => {
    vi.mocked(repository.findMailImport).mockResolvedValueOnce(row())
    vi.mocked(readArchivePage).mockResolvedValueOnce(page([mail], null, 1))
    vi.mocked(fileMail).mockRejectedValueOnce(new ImportMovedOnError())

    expect((await runMailImportSlice(session, payload, 'org_1')).done).toBe(true)
    expect(renderPendingThreads).toHaveBeenCalledOnce()
  })

  it('ends the import when the storage fills up while a Verlauf is rendered', async () => {
    vi.mocked(repository.findMailImport).mockResolvedValueOnce(row())
    vi.mocked(readArchivePage).mockResolvedValueOnce(page([mail], null, 1))
    vi.mocked(renderPendingThreads).mockResolvedValueOnce(rendered({ quotaFull: true, waiting: 1 }))

    await runMailImportSlice(session, payload, 'org_1')
    expect(repository.updateMailImport).toHaveBeenCalledWith('org_1', payload.importId, ['queued', 'importing'], expect.objectContaining({
      status: 'failed', errorCode: 'quota',
    }))
  })

  it('names a Verlauf the upload path refused on the import and counts it skipped', async () => {
    vi.mocked(repository.findMailImport).mockResolvedValueOnce(row({ skippedSamples: [{ mail: '#1', file: null, reason: 'unreadable' }] }))
    vi.mocked(readArchivePage).mockResolvedValueOnce(page([], null, 0))
    vi.mocked(renderPendingThreads).mockResolvedValueOnce(rendered({ skipped: [{ name: 'Statik Huber 2025-03-12', reason: 'screened' }] }))

    await runMailImportSlice(session, payload, 'org_1')
    expect(repository.recordSkippedFiles).toHaveBeenCalledWith('org_1', payload.importId, 1, [
      { mail: '#1', file: null, reason: 'unreadable' },
      { mail: 'Statik Huber 2025-03-12', file: null, reason: 'screened' },
    ])
  })

  it('renders into a Verlauf batch of the import’s own, quiet as D35 says, and rolls it over', async () => {
    const threads0 = importBatchId(row().id, 0, 'threads')
    vi.mocked(repository.findMailImport).mockResolvedValueOnce(row())
    vi.mocked(readArchivePage).mockResolvedValueOnce(page([], null, 0))
    vi.mocked(renderPendingThreads).mockImplementationOnce(async (_filing, target) => {
      expect(await target.uploadBatchId()).toBe(threads0)
      target.counted()
      expect(await target.uploadBatchId()).toBe(threads0)
      return rendered({ rendered: 1 })
    })

    await runMailImportSlice(session, payload, 'org_1')
    expect(openUploadBatch).toHaveBeenCalledWith(session, expect.objectContaining({ id: threads0, effects: ARCHIVE_THREAD_RENDER_EFFECTS }))
    expect(openUploadBatch).toHaveBeenCalledTimes(2)
    expect(batchStore.get(threads0)).toEqual({ sealed: true, documents: 0 })
    // The files batch is never the quiet one.
    expect(vi.mocked(openUploadBatch).mock.calls.find(([, input]) => input.id === importBatchId(row().id, 0))?.[1]).not.toHaveProperty('effects')
  })
})

describe('runMailImportSlice, upload batch', () => {
  const batch0 = importBatchId(row().id, 0)
  const batch1 = importBatchId(row().id, 1)

  it('opens one upload batch as the starter, files into it, and seals it when the import completes', async () => {
    vi.mocked(repository.findMailImport).mockResolvedValueOnce(row())
    vi.mocked(readArchivePage).mockResolvedValueOnce(page([mail, contact], null))

    await runMailImportSlice(session, payload, 'org_1')

    expect(openUploadBatch).toHaveBeenCalledWith(session, expect.objectContaining({
      id: batch0, scope: 'project', projectId: row().projectId, expectedCount: 0,
    }))
    expect(vi.mocked(filingContext).mock.calls[0][0]).toMatchObject({ uploadBatch: { id: batch0, documents: 0 } })
    expect(sealJobUploadBatch).toHaveBeenCalledWith('org_1', batch0, 'user_anna')
    expect(batchStore.get(batch0)).toEqual({ sealed: true, documents: 0 })
  })

  it('resumes into the batch an earlier slice opened, stepping over a sealed one', async () => {
    batchStore.set(batch0, { sealed: true, documents: 2 })
    batchStore.set(batch1, { sealed: false, documents: 5 })
    vi.mocked(repository.findMailImport).mockResolvedValueOnce(row())
    vi.mocked(readArchivePage).mockResolvedValueOnce(page([mail], 1))
    vi.mocked(fileMail).mockRejectedValueOnce(new SliceBudgetSpentError())

    expect((await runMailImportSlice(session, payload, 'org_1')).done).toBe(false)
    expect(openUploadBatch).not.toHaveBeenCalled()
    expect(vi.mocked(filingContext).mock.calls[0][0]).toMatchObject({ uploadBatch: { id: batch1, generation: 1, documents: 5 } })
    expect(sealJobUploadBatch).not.toHaveBeenCalled()
  })

  it('seals the batch when the import fails', async () => {
    vi.mocked(repository.findMailImport).mockResolvedValueOnce(row())
    vi.mocked(readArchivePage).mockRejectedValueOnce(new UnreadableArchiveError('not a readable Outlook archive'))

    await runMailImportSlice(session, payload, 'org_1')
    expect(sealJobUploadBatch).toHaveBeenCalledWith('org_1', batch0, 'user_anna')
  })

  it('seals the batch when the import ends because its starter left', async () => {
    batchStore.set(batch0, { sealed: false, documents: 3 })
    vi.mocked(repository.findMailImport).mockResolvedValueOnce(row())

    await runMailImportSlice(null, payload, 'org_1')
    expect(sealJobUploadBatch).toHaveBeenCalledWith('org_1', batch0, 'user_anna')
  })

  it('ends the import even when its batch cannot be sealed', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    batchStore.set(batch0, { sealed: false, documents: 3 })
    vi.mocked(sealJobUploadBatch).mockRejectedValueOnce(new Error('db hiccup'))
    vi.mocked(repository.findMailImport).mockResolvedValueOnce(row())

    await runMailImportSlice(null, payload, 'org_1')
    expect(discardStaging).toHaveBeenCalledOnce()
    expect(emitInboxItems).toHaveBeenCalledWith([expect.objectContaining({ type: 'mail_import.failed' })])
  })

  describe('when the archive folder went to the Papierkorb', () => {
    it('ends the import at a slice start, filing nothing and making no new folder', async () => {
      vi.mocked(repository.findMailImport).mockResolvedValueOnce(row({ nextPosition: 40, mailsFiled: 40 }))
      vi.mocked(resolveShelfFolderPath).mockResolvedValueOnce(null)

      expect((await runMailImportSlice(session, payload, 'org_1')).done).toBe(true)
      expect(readArchivePage).not.toHaveBeenCalled()
      expect(createFolderWithFreeName).not.toHaveBeenCalled()
      expect(enqueueJob).not.toHaveBeenCalled()
      expect(repository.updateMailImport).toHaveBeenCalledWith('org_1', payload.importId, ['queued', 'importing'], expect.objectContaining({
        status: 'failed', errorCode: 'stopped', lastError: expect.stringMatching(/Papierkorb/),
      }))
      expect(emitInboxItems).toHaveBeenCalledWith([expect.objectContaining({ type: 'mail_import.failed' })])
    })

    it('ends the import at once when it is binned in the middle of a slice, instead of handing on', async () => {
      vi.mocked(repository.findMailImport).mockResolvedValueOnce(row())
      vi.mocked(readArchivePage).mockResolvedValueOnce(page([mail], null, 1))
      vi.mocked(fileMail).mockRejectedValueOnce(new NotFoundError('Folder not found in project'))
      vi.mocked(resolveShelfFolderPath).mockResolvedValueOnce('E-Mail-Import/Büro 2019').mockResolvedValueOnce(null)

      expect((await runMailImportSlice(session, payload, 'org_1')).done).toBe(true)
      expect(enqueueJob).not.toHaveBeenCalled()
      expect(repository.advanceMailImport).not.toHaveBeenCalled()
      expect(repository.updateMailImport).toHaveBeenCalledWith('org_1', payload.importId, ['queued', 'importing'], expect.objectContaining({
        status: 'failed', errorCode: 'stopped', lastError: expect.stringMatching(/Papierkorb/),
      }))
    })

    it('hands on when only a folder inside it was binned: the next slice files the mail into a new one', async () => {
      vi.spyOn(console, 'warn').mockImplementation(() => {})
      vi.mocked(repository.findMailImport).mockResolvedValue(row())
      vi.mocked(readArchivePage).mockResolvedValueOnce(page([mail], null, 1))
      vi.mocked(fileMail).mockRejectedValueOnce(new NotFoundError('Folder not found in project'))

      expect((await runMailImportSlice(session, payload, 'org_1')).done).toBe(true)
      expect(enqueueJob).toHaveBeenCalledOnce()
      expect(repository.updateMailImport).not.toHaveBeenCalledWith('org_1', payload.importId, ['queued', 'importing'], expect.objectContaining({ status: 'failed' }))
      vi.mocked(repository.findMailImport).mockReset()
    })
  })
})

describe('sweepStaleMailImports', () => {
  it('aborts an unfinished upload, requeues an import without a job, and leaves one with a job', async () => {
    vi.mocked(repository.listStaleOpenImports).mockResolvedValueOnce([
      row({ id: 'a', status: 'uploading', uploadId: 'u1' }),
      row({ id: 'b', status: 'importing' }),
      row({ id: 'c', status: 'queued' }),
    ])
    vi.mocked(findOpenJobId).mockImplementation(async ({ matching }) => (matching.importId === 'c' ? 'job_c' : null))

    const result = await sweepStaleMailImports(new Date('2026-10-08T12:00:00Z'))
    expect(result).toEqual({ checked: 3, aborted: 1, requeued: 1, failed: 0, waiting: 1, errors: 0 })
    expect(enqueueJob).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'mail_import',
      payload: expect.objectContaining({ importId: 'b', requester: expect.objectContaining({ userId: 'user_anna' }) }),
    }))
  })

  it('fails an import whose job keeps disappearing, and one whose starter left', async () => {
    vi.mocked(repository.listStaleOpenImports).mockResolvedValueOnce([
      row({ id: 'spent', status: 'importing', failureStreak: 6 }),
      row({ id: 'left', status: 'importing' }),
    ])
    vi.mocked(findOpenJobId).mockResolvedValue(null)
    vi.mocked(resolvePinnedRequesterSession)
      .mockResolvedValueOnce({ userId: 'user_anna' } as never)
      .mockResolvedValueOnce(null)

    const result = await sweepStaleMailImports(new Date('2026-10-08T12:00:00Z'))
    expect(result).toMatchObject({ failed: 2, requeued: 0 })
    expect(enqueueJob).not.toHaveBeenCalled()
  })
})
