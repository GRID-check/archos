/**
 * @vitest-environment node
 */
/**
 * Piloti's hands on Anmerkungen (`POST /api/internal/document-annotations`).
 *
 * What is pinned here: the document is ALWAYS the conversation's subject,
 * never one named in the request; a conversation not about a document is a
 * typed 422 the tool relays; a held upload reaches no model; a subject in a
 * restricted folder is admitted against the conversation first; and what
 * Piloti sets is born a proposal, on behalf of the asker, under the asker's
 * own access rules.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('server-only', () => ({}))
vi.mock('@/lib/api/internal-envelope', () => ({
  requireVerifiedContext: vi.fn(),
  requirePinnedSession: vi.fn(),
}))
vi.mock('@/lib/conversations/repository', () => ({ findConversationInOrg: vi.fn() }))
vi.mock('@/lib/documents/repository', () => ({ findDocumentInOrg: vi.fn() }))
vi.mock('@/lib/documents/version-content', () => ({ admitSubjectRead: vi.fn() }))
vi.mock('@/lib/annotations/service', () => ({
  PILOTI: { kind: 'piloti' },
  listAnnotationsForAgent: vi.fn(),
  proposeAnnotations: vi.fn(),
  replyToAnnotation: vi.fn(),
}))
vi.mock('@/lib/db/tenant-context', async (original) => ({
  ...(await original<typeof import('@/lib/db/tenant-context')>()),
  withTenant: (_scope: unknown, run: () => unknown) => run(),
}))

import { requirePinnedSession, requireVerifiedContext } from '@/lib/api/internal-envelope'
import { listAnnotationsForAgent, proposeAnnotations, replyToAnnotation } from '@/lib/annotations/service'
import type { AuthorizedSession } from '@/lib/auth/types'
import { findConversationInOrg } from '@/lib/conversations/repository'
import type { Conversation, Document } from '@/lib/db/schema'
import { findDocumentInOrg } from '@/lib/documents/repository'
import { admitSubjectRead } from '@/lib/documents/version-content'
import type { VerifiedGridRequestContext } from '@/lib/request-context'
import { POST } from './route'

const SECRET = 'test-internal-token-annotations'
const DOC_ID = '11111111-1111-4111-8111-111111111111'
const OTHER_DOC = '22222222-2222-4222-8222-222222222222'
const SESSION = { userId: 'user_1', organizationId: 'org_1' } as Partial<AuthorizedSession> as AuthorizedSession
const CONTEXT = {
  organizationId: 'org_1',
  userId: 'user_1',
  projectId: 'proj_1',
  conversationId: 'conv_1',
  issuedAt: Date.now(),
  collectionScope: [],
} as Partial<VerifiedGridRequestContext> as VerifiedGridRequestContext

const post = (body: unknown) =>
  POST(
    new Request('https://grid.test/api/internal/document-annotations', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-grid-internal-token': SECRET },
      body: JSON.stringify(body),
    })
  )

const PROPOSAL = {
  page: 1,
  shape: 'region',
  x: 0.1,
  y: 0.2,
  w: 0.3,
  h: 0.1,
  kind: 'defect',
  body: 'Tür ohne Feuerwiderstandsklasse',
  basis: 'OIB-RL 2, Pkt. 3.4',
}

beforeEach(() => {
  vi.clearAllMocks()
  process.env.GRID_INTERNAL_API_TOKEN = SECRET
  vi.mocked(requireVerifiedContext).mockReturnValue(CONTEXT)
  vi.mocked(requirePinnedSession).mockResolvedValue(SESSION)
  vi.mocked(findConversationInOrg).mockResolvedValue({
    subjectResourceType: 'document',
    subjectResourceId: DOC_ID,
  } as Partial<Conversation> as Conversation)
  vi.mocked(findDocumentInOrg).mockResolvedValue({ id: DOC_ID } as Partial<Document> as Document)
  vi.mocked(admitSubjectRead).mockResolvedValue(false)
  vi.mocked(listAnnotationsForAgent).mockResolvedValue({ documentId: DOC_ID, annotations: [] })
  vi.mocked(proposeAnnotations).mockResolvedValue({
    annotations: [{ id: 'ann_1', number: 4, page: 1 }] as never,
  })
})

afterEach(() => {
  delete process.env.GRID_INTERNAL_API_TOKEN
})

describe('POST /api/internal/document-annotations', () => {
  it("reads the conversation's subject as the asker", async () => {
    const response = await post({ op: 'list' })

    expect(response.status).toBe(200)
    expect(listAnnotationsForAgent).toHaveBeenCalledWith(SESSION, DOC_ID)
    expect(findDocumentInOrg).toHaveBeenCalledWith(DOC_ID, 'org_1', expect.anything())
  })

  it('proposes on the subject, as Piloti for the asker, and says which numbers it took', async () => {
    const response = await post({ op: 'propose', proposals: [PROPOSAL] })

    expect(response.status).toBe(200)
    expect(proposeAnnotations).toHaveBeenCalledWith(SESSION, DOC_ID, [PROPOSAL])
    await expect(response.json()).resolves.toEqual({ documentId: DOC_ID, proposed: [{ id: 'ann_1', number: 4, page: 1 }] })
  })

  it('answers in a thread as Piloti', async () => {
    vi.mocked(replyToAnnotation).mockResolvedValue({ annotation: { id: OTHER_DOC, number: 2, replies: [{}] } as never })

    await post({ op: 'reply', annotationId: OTHER_DOC, body: 'Die lichte Breite ist im Schnitt B-B kotiert.' })

    expect(replyToAnnotation).toHaveBeenCalledWith(
      SESSION,
      DOC_ID,
      OTHER_DOC,
      { body: 'Die lichte Breite ist im Schnitt B-B kotiert.' },
      { kind: 'piloti' }
    )
  })

  it('takes no document from the request: a named one is refused as an unknown field', async () => {
    const response = await post({ op: 'list', documentId: OTHER_DOC })

    expect(response.status).toBe(400)
    expect(listAnnotationsForAgent).not.toHaveBeenCalled()
  })

  it('refuses a conversation that is not about a document, with the reason the tool relays', async () => {
    vi.mocked(findConversationInOrg).mockResolvedValue({
      subjectResourceType: null,
      subjectResourceId: null,
    } as Partial<Conversation> as Conversation)

    const response = await post({ op: 'propose', proposals: [PROPOSAL] })

    expect(response.status).toBe(422)
    await expect(response.json()).resolves.toMatchObject({ details: { reason: 'no-document-subject' } })
    expect(proposeAnnotations).not.toHaveBeenCalled()
  })

  it('reaches no held upload: a subject that has not passed screening is not found', async () => {
    vi.mocked(findDocumentInOrg).mockResolvedValue(null)

    const response = await post({ op: 'list' })

    expect(response.status).toBe(404)
    expect(listAnnotationsForAgent).not.toHaveBeenCalled()
  })

  it("admits a restricted subject against the conversation first, marking the turn's answer", async () => {
    const answerMessageId = '33333333-3333-4333-8333-333333333333'
    await post({ op: 'list', answerMessageId })

    expect(admitSubjectRead).toHaveBeenCalledWith({ id: DOC_ID }, 'org_1', 'conv_1', {
      askerUserId: 'user_1',
      answerMessageId,
    })
  })

  it('refuses a proposal off its page and more than twenty at once', async () => {
    expect((await post({ op: 'propose', proposals: [{ ...PROPOSAL, x: 0.9 }] })).status).toBe(400)
    expect((await post({ op: 'propose', proposals: Array.from({ length: 21 }, () => PROPOSAL) })).status).toBe(400)
    expect(proposeAnnotations).not.toHaveBeenCalled()
  })

  it('refuses a caller without the internal token', async () => {
    const response = await POST(
      new Request('https://grid.test/api/internal/document-annotations', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ op: 'list' }),
      })
    )

    expect(response.status).toBeGreaterThanOrEqual(401)
    expect(listAnnotationsForAgent).not.toHaveBeenCalled()
  })
})
