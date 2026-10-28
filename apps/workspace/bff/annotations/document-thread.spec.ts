/**
 * @vitest-environment node
 */
/**
 * One person's thread about one document (ADR-0106): a derived id, created on
 * first use with the document as its subject, the same for the canvas and
 * for a wake of Piloti by that person's reply, and never somebody else's.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/conversations/repository', () => ({ insertConversation: vi.fn(), findConversationInOrg: vi.fn() }))
vi.mock('@/lib/authz/projects', () => ({ requireProjectAccess: vi.fn() }))

import { ForbiddenError } from '@/lib/api/errors'
import type { AuthorizedSession } from '@/lib/auth/types'
import { requireProjectAccess } from '@/lib/authz/projects'
import { findConversationInOrg, insertConversation } from '@/lib/conversations/repository'
import type { Conversation } from '@/lib/db/schema/conversations'
import { ensureDocumentThread } from './document-thread'
import { documentThreadConversationId } from './wake-ids'

const SESSION = { userId: 'user_anna', organizationId: 'org_1' } as AuthorizedSession
const DOC = { id: 'doc_1', projectId: 'proj_1', filename: 'grundriss.pdf', displayName: 'Grundriss EG' }
const ID = documentThreadConversationId('doc_1', 'user_anna')

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(requireProjectAccess).mockResolvedValue(undefined as never)
  vi.mocked(insertConversation).mockResolvedValue({ id: ID } as Conversation)
})

describe('documentThreadConversationId', () => {
  it('is one id per person per document, in the app’s conversation id shape', () => {
    expect(ID).toMatch(/^s_[0-9a-f]{8}_[0-9a-f]{4}_5[0-9a-f]{3}_[0-9a-f]{4}_[0-9a-f]{12}$/)
    expect(documentThreadConversationId('doc_1', 'user_anna')).toBe(ID)
    expect(documentThreadConversationId('doc_1', 'user_jakob')).not.toBe(ID)
    expect(documentThreadConversationId('doc_2', 'user_anna')).not.toBe(ID)
  })
})

describe('ensureDocumentThread', () => {
  it('creates the person’s private thread with the document as its subject, in its project', async () => {
    await expect(ensureDocumentThread(SESSION, DOC)).resolves.toBe(ID)

    expect(requireProjectAccess).toHaveBeenCalledWith(SESSION, 'proj_1', expect.anything())
    expect(insertConversation).toHaveBeenCalledWith({
      id: ID,
      organizationId: 'org_1',
      createdBy: 'user_anna',
      title: 'Grundriss EG',
      projectId: 'proj_1',
      subjectResourceType: 'document',
      subjectResourceId: 'doc_1',
    })
  })

  it('answers the existing thread when it is already there', async () => {
    vi.mocked(insertConversation).mockResolvedValue(null)
    vi.mocked(findConversationInOrg).mockResolvedValue({ id: ID, createdBy: 'user_anna', deletedAt: null } as Conversation)

    await expect(ensureDocumentThread(SESSION, DOC, 'Grundriss · Prüfansicht')).resolves.toBe(ID)
  })

  it('never hands out a row that is not the person’s, and waits out one being deleted', async () => {
    vi.mocked(insertConversation).mockResolvedValue(null)
    vi.mocked(findConversationInOrg).mockResolvedValue({ id: ID, createdBy: 'user_jakob', deletedAt: null } as Conversation)
    await expect(ensureDocumentThread(SESSION, DOC)).rejects.toMatchObject({ status: 404 })

    vi.mocked(findConversationInOrg).mockResolvedValue({ id: ID, createdBy: 'user_anna', deletedAt: new Date() } as Conversation)
    await expect(ensureDocumentThread(SESSION, DOC)).rejects.toMatchObject({ status: 409 })
  })

  it('creates nothing for a person who may not chat in the project', async () => {
    vi.mocked(requireProjectAccess).mockRejectedValue(new ForbiddenError())

    await expect(ensureDocumentThread(SESSION, DOC)).rejects.toMatchObject({ status: 403 })
    expect(insertConversation).not.toHaveBeenCalled()
  })
})
