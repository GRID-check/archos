/**
 * @vitest-environment node
 */
/**
 * Piloti's hands on Anmerkungen (`POST /api/internal/document-annotations`).
 *
 * What is pinned here: the document is the conversation's subject unless the
 * turn names one, and a named one is admitted only inside the collections the
 * turn's envelope signs (anything else is an unknown document); with neither,
 * a typed 422 the tool relays; a held upload reaches no model; a subject in a
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
vi.mock('@/lib/documents/access', () => ({ getAccessibleDocument: vi.fn() }))
vi.mock('@/lib/realtime/document-channel', () => ({
  pilotiPeer: (conversationId: string, userId: string) => ({ peerId: `piloti-${conversationId}`, userId }),
  publishAsAgent: vi.fn(),
  roomSnapshot: vi.fn(),
}))
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
import { getAccessibleDocument } from '@/lib/documents/access'
import { admitSubjectRead } from '@/lib/documents/version-content'
import { publishAsAgent, roomSnapshot } from '@/lib/realtime/document-channel'
import type { VerifiedGridRequestContext } from '@/lib/request-context'
import { NotFoundError } from '@/lib/api/errors'
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
  collectionScope: ['proj_1_docs'],
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
  vi.mocked(findDocumentInOrg).mockImplementation(async (id) =>
    ({ id, filename: id === DOC_ID ? 'Grundriss EG.pdf' : 'Schnitt A-A.pdf', collectionName: 'proj_1_docs' }) as Partial<Document> as Document
  )
  vi.mocked(admitSubjectRead).mockResolvedValue(false)
  vi.mocked(listAnnotationsForAgent).mockResolvedValue({ documentId: DOC_ID, annotations: [] })
  vi.mocked(proposeAnnotations).mockResolvedValue({
    annotations: [{ id: 'ann_1', number: 4, ...PROPOSAL }] as never,
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
    await expect(response.json()).resolves.toMatchObject({ documentName: 'Grundriss EG.pdf' })
  })

  it('proposes on the subject, as Piloti for the asker, and says which numbers it took', async () => {
    const response = await post({ op: 'propose', proposals: [PROPOSAL] })

    expect(response.status).toBe(200)
    expect(proposeAnnotations).toHaveBeenCalledWith(SESSION, DOC_ID, [PROPOSAL])
    await expect(response.json()).resolves.toEqual({
      documentId: DOC_ID,
      documentName: 'Grundriss EG.pdf',
      proposed: [{ id: 'ann_1', number: 4, page: 1, shape: 'region', x: 0.1, y: 0.2, w: 0.3, h: 0.1, kind: 'defect', body: PROPOSAL.body }],
    })
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

  it('acts on a document the turn names, from a chat about something else, inside the signed scope', async () => {
    vi.mocked(findConversationInOrg).mockResolvedValue({
      subjectResourceType: null,
      subjectResourceId: null,
    } as Partial<Conversation> as Conversation)

    const response = await post({ op: 'propose', documentId: OTHER_DOC, proposals: [PROPOSAL] })

    expect(response.status).toBe(200)
    expect(proposeAnnotations).toHaveBeenCalledWith(SESSION, OTHER_DOC, [PROPOSAL])
    await expect(response.json()).resolves.toMatchObject({ documentId: OTHER_DOC, documentName: 'Schnitt A-A.pdf' })
  })

  it('treats a named document outside the signed scope as unknown', async () => {
    vi.mocked(findDocumentInOrg).mockResolvedValue({
      id: OTHER_DOC,
      filename: 'Fremd.pdf',
      collectionName: 'proj_9_docs',
    } as Partial<Document> as Document)

    const response = await post({ op: 'list', documentId: OTHER_DOC })

    expect(response.status).toBe(404)
    expect(listAnnotationsForAgent).not.toHaveBeenCalled()
  })

  it('admits a named document in a restricted folder against the conversation, like the subject', async () => {
    await post({ op: 'list', documentId: OTHER_DOC })

    expect(admitSubjectRead).toHaveBeenCalledWith(expect.objectContaining({ id: OTHER_DOC }), 'org_1', 'conv_1', {
      askerUserId: 'user_1',
      answerMessageId: null,
    })
  })

  it('refuses an unknown field: the turn cannot name a person or an organization', async () => {
    const response = await post({ op: 'list', organizationId: 'org_2' })

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

    expect(admitSubjectRead).toHaveBeenCalledWith(expect.objectContaining({ id: DOC_ID }), 'org_1', 'conv_1', {
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

  describe('the room', () => {
    const ANNA = {
      peerId: 'peer_anna',
      userId: 'user_anna',
      name: 'Anna Berger',
      kind: 'person' as const,
      page: 2,
      viewport: { page: 2, y: 0.4 },
      selected: 'ann_7',
      draft: { page: 2, x: 0.1, y: 0.2, w: 0.3, h: 0.1 },
      expiresAt: '2026-10-13T12:00:00.000Z',
    }

    it('says who is in the document and where, by mark number, without Piloti itself', async () => {
      vi.mocked(listAnnotationsForAgent).mockResolvedValue({
        documentId: DOC_ID,
        annotations: [
          { id: 'ann_7', number: 7, status: 'open' },
          { id: 'ann_8', number: 8, status: 'proposed' },
        ] as never,
      })
      vi.mocked(roomSnapshot).mockResolvedValue([
        ANNA,
        { ...ANNA, peerId: 'piloti-conv_1', name: 'Piloti', kind: 'piloti', selected: null, draft: null },
      ])

      const response = await post({ op: 'room' })

      expect(response.status).toBe(200)
      await expect(response.json()).resolves.toEqual({
        documentId: DOC_ID,
        documentName: 'Grundriss EG.pdf',
        peers: [
          {
            name: 'Anna Berger',
            kind: 'person',
            page: 2,
            viewport: { page: 2, y: 0.4 },
            selectedMarkNumber: 7,
            draft: { page: 2, x: 0.1, y: 0.2, w: 0.3, h: 0.1 },
          },
        ],
        marks: { open: 1, proposed: 1 },
      })
    })

    it('points and highlights as Piloti for this conversation, after checking the asker may read', async () => {
      await post({ op: 'point', page: 1, x: 0.4, y: 0.5, label: 'Hier' })
      await post({ op: 'highlight', page: 1, x: 0.8, y: 0.1, w: 0.4, h: 0.2, label: 'Fluchtweg 1,10 m' })

      expect(getAccessibleDocument).toHaveBeenCalledWith(SESSION, DOC_ID, 'read')
      const agent = { organizationId: 'org_1', conversationId: 'conv_1', onBehalfOf: 'user_1' }
      expect(vi.mocked(publishAsAgent).mock.calls).toEqual([
        [DOC_ID, 'org_1', agent, { op: 'presence', state: 'here' }],
        [DOC_ID, 'org_1', agent, { op: 'cursor', cursor: { page: 1, x: 0.4, y: 0.5 }, label: 'Hier' }],
        [DOC_ID, 'org_1', agent, { op: 'presence', state: 'here' }],
        // A box past the page's edge is clamped onto it.
        [DOC_ID, 'org_1', agent, { op: 'highlight', box: { page: 1, x: 0.8, y: 0.1, w: expect.closeTo(0.2), h: 0.2 }, label: 'Fluchtweg 1,10 m' }],
      ])
    })

    it('leaves: pointer off, activity cleared, presence gone', async () => {
      await post({ op: 'leave' })

      expect(vi.mocked(publishAsAgent).mock.calls.map((call) => call[3])).toEqual([
        { op: 'cursor', cursor: null },
        { op: 'activity', state: 'idle' },
        { op: 'presence', state: 'gone' },
      ])
    })

    it('makes no gesture for an asker who may not read the document', async () => {
      vi.mocked(getAccessibleDocument).mockRejectedValue(new NotFoundError('Document not found'))

      const response = await post({ op: 'point', page: 1, x: 0.4, y: 0.5 })

      expect(response.status).toBe(404)
      expect(publishAsAgent).not.toHaveBeenCalled()
    })

    it('refuses a highlight without a label, and a point off the page', async () => {
      expect((await post({ op: 'highlight', page: 1, x: 0.1, y: 0.1, w: 0.2, h: 0.2 })).status).toBe(400)
      expect((await post({ op: 'point', page: 1, x: 1.4, y: 0.5 })).status).toBe(400)
      expect(publishAsAgent).not.toHaveBeenCalled()
    })
  })
})
