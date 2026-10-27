/**
 * @vitest-environment node
 *
 * Both upload doors admit a file through the same gates, in the same order,
 * before a byte is stored (ADR-0086): name screen, type, size, quota.
 *
 * The doors are driven for real; only the gates (recording each call), what a
 * door checks before admission, and the first step after it are mocked. That
 * step is `acceptedUploadBatchId`, the first thing both doors do once a file is
 * admitted; `ensureTenantBucketChecked`, the provisioning before the PUT, is
 * watched too, so "not called" means no byte reached storage.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('server-only', () => ({}))

const calls = vi.hoisted(() => [] as string[])
const assertUploadNameAllowed = vi.hoisted(() => vi.fn())
const assertUploadTypeAllowed = vi.hoisted(() => vi.fn())
const assertFileSizeAllowed = vi.hoisted(() => vi.fn())
const assertWithinStorageQuota = vi.hoisted(() => vi.fn())
const ensureTenantBucketChecked = vi.hoisted(() => vi.fn())
const acceptedUploadBatchId = vi.hoisted(() => vi.fn())

vi.mock('@/lib/upload-screening/service', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/upload-screening/service')>()),
  assertUploadNameAllowed,
}))
vi.mock('./upload-type', () => ({ assertUploadTypeAllowed }))
vi.mock('@/lib/storage/upload-limit', () => ({ assertFileSizeAllowed }))
vi.mock('@/lib/storage/service', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/storage/service')>()),
  assertWithinStorageQuota,
}))
vi.mock('@/lib/storage/bucket', () => ({ ensureTenantBucketChecked }))
vi.mock('@/lib/upload-batches/service', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/upload-batches/service')>()),
  acceptedUploadBatchId,
}))

// What each door checks before admission: the caller may write here.
vi.mock('./shelf-authz', () => ({ requireShelfWrite: vi.fn() }))
vi.mock('./shelf-collection', () => ({ shelfCollectionName: vi.fn(async () => 'proj_abc') }))
vi.mock('@/lib/authz/folder-access', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/authz/folder-access')>()),
  getProjectFolderAccess: vi.fn(async () => ({
    isVisible: () => true,
    levelOf: () => 'write',
    collectionFor: () => 'proj_abc',
  })),
}))
vi.mock('@/lib/conversations/service', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/conversations/service')>()),
  createConversation: vi.fn(),
}))

import { BadRequestError, FileTooLargeError, InsufficientStorageError } from '@/lib/api/errors'
import type { AuthorizedSession } from '@/lib/auth/types'
import { ScreenedUploadError } from '@/lib/upload-screening/service'
import { uploadSessionDocument } from '@/lib/session-documents/service'
import { uploadToShelf } from './shelf-upload'
import { admitFileBeforeReading } from './upload-admission'

const SESSION = { userId: 'user-1', organizationId: 'org-1', email: 'a@b.example' } as AuthorizedSession
const ALL_GATES = ['name', 'type', 'size', 'quota']

const file = () => new File([new Uint8Array([1, 2, 3])], 'plan.pdf', { type: 'application/pdf' })
const request = () => new Request('https://grid.example/api/documents/upload', { method: 'POST' })

/** Stops the door right after admission, so a pass is observable without storage. */
class PastAdmission extends Error {}

const DOORS = {
  'the project shelf': () =>
    uploadToShelf(SESSION, { kind: 'project', projectId: 'proj-1' }, { file: file(), folderId: null }, request()),
  'the Archiv': () => uploadToShelf(SESSION, { kind: 'office_shelf' }, { file: file(), folderId: null }, request()),
  'a chat attachment': () =>
    uploadSessionDocument(SESSION, { conversationId: 'conv-1', file: file() }, request()),
}

const REFUSALS = [
  ['name', () => new ScreenedUploadError([])],
  ['type', () => new BadRequestError('File type ".exe" is not permitted')],
  ['size', () => new FileTooLargeError({ fileSize: 3, maxSizeBytes: 1 })],
  ['quota', () => new InsufficientStorageError()],
] as const

beforeEach(() => {
  calls.length = 0
  vi.clearAllMocks()
  assertUploadNameAllowed.mockImplementation(async () => {
    calls.push('name')
    return { overridden: [] }
  })
  assertUploadTypeAllowed.mockImplementation(async () => void calls.push('type'))
  assertFileSizeAllowed.mockImplementation(async () => void calls.push('size'))
  assertWithinStorageQuota.mockImplementation(async () => void calls.push('quota'))
  acceptedUploadBatchId.mockImplementation(async () => {
    calls.push('admitted')
    throw new PastAdmission()
  })
})

describe.each(Object.entries(DOORS))('%s', (_door, upload) => {
  it('runs the name screen, type, size and quota, in that order, before storing a byte', async () => {
    await expect(upload()).rejects.toBeInstanceOf(PastAdmission)

    expect(calls).toEqual([...ALL_GATES, 'admitted'])
    expect(ensureTenantBucketChecked).not.toHaveBeenCalled()
    expect(assertFileSizeAllowed).toHaveBeenCalledWith('org-1', 3, 'plan.pdf')
    expect(assertWithinStorageQuota).toHaveBeenCalledWith('org-1', 3)
  })

  it.each(REFUSALS)('stops at a %s refusal, with that gate’s own error, and stores nothing', async (gate, refusal) => {
    const error = refusal()
    const mocks = {
      name: assertUploadNameAllowed,
      type: assertUploadTypeAllowed,
      size: assertFileSizeAllowed,
      quota: assertWithinStorageQuota,
    }
    mocks[gate].mockImplementation(async () => {
      calls.push(gate)
      throw error
    })

    await expect(upload()).rejects.toBe(error)

    expect(calls).toEqual(ALL_GATES.slice(0, ALL_GATES.indexOf(gate) + 1))
    expect(acceptedUploadBatchId).not.toHaveBeenCalled()
    expect(ensureTenantBucketChecked).not.toHaveBeenCalled()
  })
})

describe('the name screen reads the destination', () => {
  it('screens a project upload with the project’s own terms and its folder', async () => {
    await expect(DOORS['the project shelf']()).rejects.toBeInstanceOf(PastAdmission)

    expect(assertUploadNameAllowed).toHaveBeenCalledWith(
      'org-1',
      { filename: 'plan.pdf', originPath: null, folderPath: null },
      false,
      'proj-1',
    )
  })

  it('screens a chat attachment with the organization’s terms', async () => {
    await expect(DOORS['a chat attachment']()).rejects.toBeInstanceOf(PastAdmission)

    expect(assertUploadNameAllowed.mock.calls[0][0]).toBe('org-1')
    expect(assertUploadNameAllowed.mock.calls[0][1]).toMatchObject({ filename: 'plan.pdf', originPath: null })
    expect(assertUploadNameAllowed.mock.calls[0][3]).toBeUndefined()
  })
})

describe('admitFileBeforeReading', () => {
  it('asks type then size, and neither the name screen nor the quota, so mail can ask before fetching bytes', async () => {
    await admitFileBeforeReading(SESSION, { filename: 'plan.pdf', size: 3 })

    expect(calls).toEqual(['type', 'size'])
  })
})
