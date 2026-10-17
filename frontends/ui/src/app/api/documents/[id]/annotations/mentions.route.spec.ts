/**
 * @vitest-environment node
 */
/**
 * Mentioning a colleague on an Anmerkung, driven through the TYPED CLIENT and
 * the real routes, service and inbox emitters (ADR-0055): only the document
 * reader, the repository, who may open the document and the inbox's writes
 * are faked.
 *
 * What is pinned: the server keeps a mention only while its „@Name" stands in
 * the text, the name is the directory's, and the person may open the document;
 * whoever is mentioned anew is told once (`annotation.mentioned`), never
 * twice for one reply (no `annotation.activity` beside it), never themselves;
 * an edit tells only whom it adds; a Zuständige made responsible in the same
 * write hears that instead; and answering in the thread settles one's own
 * mention.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/auth/require-auth', () => ({
  requireAuthorizedSession: vi.fn().mockResolvedValue({
    userId: 'user_me',
    organizationId: 'org_1',
    email: 'miriam@buero.at',
    name: 'Miriam Hofer',
    role: 'member',
    permissions: [],
  }),
}))
vi.mock('@/lib/documents/access', () => ({ getAccessibleDocument: vi.fn() }))
vi.mock('@/lib/documents/may-open', () => ({ mayOpenDocument: vi.fn() }))
vi.mock('@/lib/authz/project-membership', () => ({
  PERMISSION_CHECKS_AT_ONCE: 8,
  userHoldsProjectPermission: vi.fn(),
  resolveSubjectMembership: vi.fn(),
}))
vi.mock('@/lib/sharing/directory', () => ({ loadOrganizationDirectory: vi.fn() }))
vi.mock('@/lib/sharing/registry', () => ({
  describeResource: () => ({ describeRef: async () => ({ title: 'Grundriss EG' }) }),
}))
vi.mock('@/lib/realtime/document-channel', () => ({ publishToDocumentRoom: vi.fn().mockResolvedValue(undefined) }))
vi.mock('@/lib/audit/service', () => ({ recordAuditEvent: vi.fn() }))
vi.mock('@/lib/mentions/service', () => ({ enforceMentionBounds: vi.fn().mockResolvedValue(undefined) }))
vi.mock('@/lib/inbox/service', () => ({
  emitInboxItems: vi.fn().mockResolvedValue(1),
  resolveInboxItemsAnchoredOn: vi.fn().mockResolvedValue(1),
  markInboxItemsInertAnchoredOn: vi.fn().mockResolvedValue(1),
}))
vi.mock('@/lib/annotations/repository', () => ({
  AnnotationLimitReachedError: class AnnotationLimitReachedError extends Error {},
  ReplyLimitReachedError: class ReplyLimitReachedError extends Error {},
  listDocumentAnnotations: vi.fn(),
  findDocumentAnnotation: vi.fn(),
  insertDocumentAnnotations: vi.fn(),
  updateDocumentAnnotation: vi.fn(),
  deleteDocumentAnnotation: vi.fn(),
  deleteAnnotationReply: vi.fn(),
  insertAnnotationReply: vi.fn(),
}))

import { createAnnotation, replyToAnnotation, updateAnnotation } from '@/lib/annotations/client'
import {
  findDocumentAnnotation,
  insertAnnotationReply,
  insertDocumentAnnotations,
  updateDocumentAnnotation,
  type AnnotationRecord,
} from '@/lib/annotations/repository'
import type { MarkMention } from '@/lib/annotations/types'
import type { Document, DocumentAnnotationReplyRow, DocumentAnnotationRow } from '@/lib/db/schema'
import { getAccessibleDocument } from '@/lib/documents/access'
import { mayOpenDocument } from '@/lib/documents/may-open'
import type { InboxEmission } from '@/lib/inbox/service'
import { emitInboxItems, resolveInboxItemsAnchoredOn } from '@/lib/inbox/service'
import { enforceMentionBounds } from '@/lib/mentions/service'
import { loadOrganizationDirectory } from '@/lib/sharing/directory'

import { POST as create } from './route'
import { PATCH as patch } from './[annotationId]/route'
import { POST as reply } from './[annotationId]/replies/route'

type Handler = (request: Request, context?: { params?: Promise<Record<string, string>> }) => Promise<Response>

const ROUTES: Array<{ pattern: RegExp; method: string; handler: Handler; params: string[] }> = [
  { pattern: /^\/api\/documents\/([^/]+)\/annotations$/, method: 'POST', handler: create, params: ['id'] },
  {
    pattern: /^\/api\/documents\/([^/]+)\/annotations\/([^/]+)$/,
    method: 'PATCH',
    handler: patch,
    params: ['id', 'annotationId'],
  },
  {
    pattern: /^\/api\/documents\/([^/]+)\/annotations\/([^/]+)\/replies$/,
    method: 'POST',
    handler: reply,
    params: ['id', 'annotationId'],
  },
]

const run = async (path: string, init?: RequestInit) => {
  const url = new URL(path, 'https://grid.test')
  const method = init?.method ?? 'GET'
  const route = ROUTES.find((entry) => entry.pattern.test(url.pathname) && entry.method === method)
  if (!route) throw new Error(`no route for ${method} ${url.pathname}`)
  const matched = route.pattern.exec(url.pathname) as RegExpExecArray
  const params = Object.fromEntries(route.params.map((name, index) => [name, decodeURIComponent(matched[index + 1])]))
  return route.handler(new Request(url, init), { params: Promise.resolve(params) })
}

const DOC = {
  id: 'doc_1',
  organizationId: 'org_1',
  scope: 'project',
  projectId: 'proj_1',
  folderId: 'folder_plans',
  publishedVersionId: 'ver_2',
} as Partial<Document> as Document

const ANNA: MarkMention = { targetId: 'user_anna', display: 'Anna Berger' }
const BEN: MarkMention = { targetId: 'user_ben', display: 'Ben Gruber' }
/** In the organization, but not cleared for the folder the document is filed in. */
const FAR: MarkMention = { targetId: 'user_far', display: 'Fritz Fern' }
const ME: MarkMention = { targetId: 'user_me', display: 'Miriam Hofer' }
const PILOTI: MarkMention = { targetId: 'agent:piloti', display: 'Piloti' }

const MARK: AnnotationRecord = {
  id: 'ann_1',
  organizationId: 'org_1',
  documentId: 'doc_1',
  versionId: 'ver_2',
  number: 4,
  page: 1,
  shape: 'point',
  x: 0.25,
  y: 0.5,
  w: null,
  h: null,
  kind: 'defect',
  body: 'Tür T30 fehlt im Fluchtweg',
  mentions: [],
  basis: null,
  authorKind: 'person',
  // Anna set the mark: she takes part in its thread.
  status: 'open',
  assigneeUserId: null,
  dueOn: null,
  createdBy: 'user_anna',
  createdAt: new Date('2026-10-01T08:00:00Z'),
  updatedAt: new Date('2026-10-01T08:00:00Z'),
  acceptedBy: null,
  acceptedAt: null,
  closedBy: null,
  closedAt: null,
  delegatedBy: null,
  delegatedAt: null,
  fassungNumber: 2,
  replies: [],
}

/** Every inbox row the writes asked for, once the after-commit work has run. */
async function rows(): Promise<InboxEmission[]> {
  await new Promise((resolve) => setTimeout(resolve, 0))
  return vi.mocked(emitInboxItems).mock.calls.flatMap(([emissions]) => emissions)
}

const rowsOf = async (type: string) =>
  (await rows()).filter((row) => row.type === type).map((row) => row.recipientUserId)

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(getAccessibleDocument).mockResolvedValue(DOC)
  vi.mocked(loadOrganizationDirectory).mockResolvedValue(
    new Map(
      [ANNA, BEN, FAR, ME].map((person) => [
        person.targetId,
        { userId: person.targetId, email: null, name: person.display, profilePictureUrl: null },
      ])
    )
  )
  vi.mocked(mayOpenDocument).mockImplementation(
    async (_tenant, _doc, userIds) => new Set(userIds.filter((userId) => userId !== FAR.targetId))
  )
  vi.mocked(findDocumentAnnotation).mockResolvedValue(MARK)
  vi.mocked(insertAnnotationReply).mockImplementation(
    async (input) =>
      ({
        id: 'rep_1',
        createdAt: new Date(),
        ...input,
        addressesAgent: input.addressesAgent ?? false,
        mentions: input.mentions ?? [],
      }) as DocumentAnnotationReplyRow
  )
  vi.mocked(insertDocumentAnnotations).mockImplementation(
    async (input) =>
      input.marks.map((mark) => ({
        ...MARK,
        ...mark,
        id: 'ann_new',
        number: 5,
        createdBy: input.createdBy,
        mentions: mark.mentions ?? [],
      })) as DocumentAnnotationRow[]
  )
  vi.mocked(updateDocumentAnnotation).mockImplementation(async (_org, _doc, _id, _status, changes) => ({
    ...MARK,
    ...changes,
  }) as DocumentAnnotationRow)
})

describe('a reply that mentions colleagues', () => {
  it('keeps only who the text still names, by the directory’s name, and who may open the document', async () => {
    await replyToAnnotation(
      'doc_1',
      'ann_1',
      {
        body: '@Anna Berger @Fritz Fern bitte prüfen',
        mentions: [
          ANNA,
          FAR,
          // Picked, then deleted from the text: nobody.
          BEN,
          // A crafted chip that names somebody else: nobody.
          { targetId: 'user_me', display: 'Die Chefin' },
        ],
      },
      { run }
    )

    expect(insertAnnotationReply).toHaveBeenCalledWith(expect.objectContaining({ mentions: [ANNA] }), undefined)
  })

  it('tells each person mentioned once, at the mark, and not again as thread activity', async () => {
    await replyToAnnotation('doc_1', 'ann_1', { body: '@Anna Berger @Ben Gruber passt das?', mentions: [ANNA, BEN] }, { run })

    expect(await rowsOf('annotation.mentioned')).toEqual(['user_anna', 'user_ben'])
    // Anna set the mark, so she takes part in its thread; the mention is her one row.
    expect(await rowsOf('annotation.activity')).toEqual([])
    const [row] = (await rows()).filter((one) => one.type === 'annotation.mentioned')
    expect(row).toMatchObject({
      resourceType: 'document',
      resourceId: 'doc_1',
      anchorId: 'ann_1',
      actorUserId: 'user_me',
      payload: { subject: 'Grundriss EG', related: '4', excerpt: '@Anna Berger @Ben Gruber passt das?' },
    })
    expect(enforceMentionBounds).toHaveBeenCalledWith(expect.objectContaining({ userId: 'user_me' }), 2)
  })

  it('still tells the thread what the reply does not mention', async () => {
    await replyToAnnotation('doc_1', 'ann_1', { body: '@Ben Gruber passt das?', mentions: [BEN] }, { run })

    expect(await rowsOf('annotation.mentioned')).toEqual(['user_ben'])
    expect(await rowsOf('annotation.activity')).toEqual(['user_anna'])
  })

  it('tells nobody about mentioning oneself, and spends no budget on it', async () => {
    await replyToAnnotation('doc_1', 'ann_1', { body: '@Miriam Hofer Notiz an mich', mentions: [ME] }, { run })

    expect(insertAnnotationReply).toHaveBeenCalledWith(expect.objectContaining({ mentions: [ME] }), undefined)
    expect(await rowsOf('annotation.mentioned')).toEqual([])
    expect(enforceMentionBounds).not.toHaveBeenCalled()
  })

  it('addresses Piloti when Piloti is mentioned, as the chip’s flag does', async () => {
    await replyToAnnotation('doc_1', 'ann_1', { body: '@Piloti stimmt die Breite?', mentions: [PILOTI] }, { run })

    expect(insertAnnotationReply).toHaveBeenCalledWith(
      expect.objectContaining({ addressesAgent: true, mentions: [PILOTI] }),
      undefined
    )
    expect(await rowsOf('annotation.mentioned')).toEqual([])
  })

  it('settles the answering person’s own mention when they answer in the thread', async () => {
    await replyToAnnotation('doc_1', 'ann_1', { body: 'Ist geprüft.' }, { run })
    await rows()

    expect(resolveInboxItemsAnchoredOn).toHaveBeenCalledWith({
      organizationId: 'org_1',
      types: ['annotation.mentioned'],
      anchorId: 'ann_1',
      recipientUserId: 'user_me',
    })
  })

  it('shows the reply with whom it mentions, by name', async () => {
    vi.mocked(findDocumentAnnotation)
      .mockResolvedValueOnce(MARK)
      .mockResolvedValue({
        ...MARK,
        replies: [
          {
            id: 'rep_1',
            organizationId: 'org_1',
            annotationId: 'ann_1',
            authorKind: 'person',
            body: '@Anna Berger bitte',
            createdBy: 'user_me',
            createdAt: new Date(),
            addressesAgent: false,
            mentions: [ANNA],
          },
        ],
      })

    const result = await replyToAnnotation('doc_1', 'ann_1', { body: '@Anna Berger bitte', mentions: [ANNA] }, { run })

    expect(result.annotation.replies[0].mentions).toEqual([ANNA])
  })
})

describe('a mark whose text mentions colleagues', () => {
  it('tells whom a new mark mentions; a Zuständige made responsible in the same write hears that instead', async () => {
    await createAnnotation(
      'doc_1',
      {
        page: 1,
        shape: 'point',
        x: 0.2,
        y: 0.2,
        kind: 'defect',
        body: '@Anna Berger @Ben Gruber Brüstung zu niedrig',
        mentions: [ANNA, BEN],
        assigneeUserId: 'user_ben',
      },
      { run }
    )

    expect(insertDocumentAnnotations).toHaveBeenCalledWith(
      expect.objectContaining({ marks: [expect.objectContaining({ mentions: [ANNA, BEN] })] })
    )
    expect(await rowsOf('annotation.mentioned')).toEqual(['user_anna'])
    expect(await rowsOf('annotation.assigned_to_you')).toEqual(['user_ben'])
  })

  it('tells only whom an edit adds, and keeps the stored mentions the new text still names', async () => {
    vi.mocked(findDocumentAnnotation).mockResolvedValue({ ...MARK, body: '@Ben Gruber Brüstung', mentions: [BEN] })

    await updateAnnotation(
      'doc_1',
      'ann_1',
      { body: '@Ben Gruber @Anna Berger Brüstung zu niedrig', mentions: [ANNA] },
      { run }
    )

    expect(updateDocumentAnnotation).toHaveBeenCalledWith(
      'org_1',
      'doc_1',
      'ann_1',
      'open',
      expect.objectContaining({ mentions: [ANNA] }),
      undefined
    )
    expect(await rowsOf('annotation.mentioned')).toEqual(['user_anna'])
  })

  it('keeps whom a reworded text still names when the edit sends none, and tells nobody new', async () => {
    vi.mocked(findDocumentAnnotation).mockResolvedValue({
      ...MARK,
      body: '@Ben Gruber @Anna Berger Brüstung',
      mentions: [BEN, ANNA],
    })

    await updateAnnotation('doc_1', 'ann_1', { body: '@Ben Gruber Brüstung zu niedrig' }, { run })

    expect(updateDocumentAnnotation).toHaveBeenCalledWith(
      'org_1',
      'doc_1',
      'ann_1',
      'open',
      expect.objectContaining({ mentions: [BEN] }),
      undefined
    )
    expect(await rowsOf('annotation.mentioned')).toEqual([])
  })

  it('refuses mentions without a body: they belong to a text', async () => {
    await expect(updateAnnotation('doc_1', 'ann_1', { kind: 'hint', mentions: [ANNA] }, { run })).rejects.toMatchObject({
      status: 400,
    })
    expect(updateDocumentAnnotation).not.toHaveBeenCalled()
  })
})
