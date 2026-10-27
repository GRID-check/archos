/**
 * @vitest-environment node
 *
 * The providers beside the documents, with their SQL mocked: what each asks
 * the repository, how a row becomes a hit, and the two rules that live in
 * TypeScript rather than SQL: a withheld conversation is never reported, and a
 * project is matched in memory over the reach. The SQL itself is proved
 * against Postgres in `providers.integration.spec.ts`.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AuthorizedSession } from '@/lib/auth/types'
import { makeProject } from '@/test-utils/db-fixtures'
import type { ReachedProject, SearchReach } from './reach'

vi.mock('server-only', () => ({}))
vi.mock('@/lib/db/tenant-context', () => ({
  withTenant: (_scope: unknown, run: () => unknown) => run(),
}))
vi.mock('./providers-repository', () => ({
  SEARCH_TOTAL_CAP: 1000,
  searchAnnotationRows: vi.fn(),
  searchFolderRows: vi.fn(),
  searchConversationRows: vi.fn(),
}))
vi.mock('@/lib/conversations/restricted-use', () => ({ lockedConversationIds: vi.fn() }))

import { lockedConversationIds } from '@/lib/conversations/restricted-use'
import {
  conversationReachOf,
  conversationTagsNamedBy,
  searchAnnotations,
  searchConversations,
  searchFolders,
  searchProjects,
} from './providers'
import {
  searchAnnotationRows,
  searchConversationRows,
  searchFolderRows,
} from './providers-repository'

const P1 = '00000000-0000-4000-8000-000000000001'
const P2 = '00000000-0000-4000-8000-000000000002'

const reached = (id: string, name: string, address?: string): ReachedProject => ({
  project: makeProject({
    id,
    name,
    organizationId: 'org_1',
    profile: {
      facts: address
        ? {
            site_address: {
              value: address,
              confidence: 'confirmed',
              source: 'onboarding',
              updatedAt: '2026-01-01',
            },
          }
        : {},
      goals: {},
      unknowns: [],
      assumptions: {},
    },
  }),
  hiddenFolderIds: [],
  collections: [],
  reviewsQuarantine: false,
})

const reach = (overrides: Partial<SearchReach> = {}): SearchReach => ({
  organizationId: 'org_1',
  userId: 'user_me',
  scope: { kind: 'office' },
  projects: [
    reached(P1, 'Wohnbau Hubergasse', 'Hubergasse 14, Wien'),
    reached(P2, 'Schule Lindengasse'),
  ],
  officeShelf: null,
  folderIds: null,
  ...overrides,
})

const session = { userId: 'user_me', organizationId: 'org_1' } as AuthorizedSession

beforeEach(() => vi.clearAllMocks())

describe('searchProjects', () => {
  it('matches the name or the site address, any case, a name match first', () => {
    const found = searchProjects(reach(), 'GASSE', { limit: 10, offset: 0 })
    expect(found.total).toBe(2)
    expect(found.hits.map((hit) => hit.name)).toEqual(['Schule Lindengasse', 'Wohnbau Hubergasse'])
    const byAddress = searchProjects(reach(), 'wien', { limit: 10, offset: 0 })
    expect(byAddress.hits).toEqual([
      {
        kind: 'project',
        id: P1,
        name: 'Wohnbau Hubergasse',
        status: 'active',
        excerpt: 'Hubergasse 14, Wien',
      },
    ])
  })

  it('only finds projects in reach, and pages', () => {
    expect(searchProjects(reach({ projects: [] }), 'Schule', { limit: 10, offset: 0 })).toEqual({
      hits: [],
      total: 0,
    })
    const page = searchProjects(reach(), 'gasse', { limit: 1, offset: 1 })
    expect(page.total).toBe(2)
    expect(page.hits.map((hit) => hit.id)).toEqual([P1])
  })
})

describe('conversationTagsNamedBy', () => {
  it('names a topic by its key, a legacy key, or its label in either language', () => {
    expect(conversationTagsNamedBy('Brandschutz')).toEqual(['fire_safety'])
    expect(conversationTagsNamedBy('fire safety')).toEqual(['fire_safety'])
    expect(conversationTagsNamedBy('schall')).toEqual(['sound_insulation'])
    expect(conversationTagsNamedBy('xy')).toEqual([])
  })
})

describe('conversationReachOf', () => {
  it('reads the whole office with the unstamped rows, a project alone without them, and nothing on a shelf or in a folder', () => {
    expect(conversationReachOf(reach())).toEqual({ projectIds: [P1, P2], withoutContainer: true })
    expect(conversationReachOf(reach({ scope: { kind: 'project', projectId: P1 } }))).toEqual({
      projectIds: [P1],
      withoutContainer: false,
    })
    expect(
      conversationReachOf(reach({ scope: { kind: 'project', projectId: P1, folderId: P2 } }))
    ).toEqual({
      projectIds: [],
      withoutContainer: false,
    })
    expect(conversationReachOf(reach({ scope: { kind: 'office_shelf' } }))).toEqual({
      projectIds: [],
      withoutContainer: false,
    })
  })
})

describe('searchConversations', () => {
  const row = (id: string, title: string, projectId: string | null = P1) => ({
    id,
    projectId,
    title,
    updatedAt: new Date('2026-10-01T00:00:00Z'),
  })

  it('drops a withheld conversation before it is counted or shown', async () => {
    vi.mocked(searchConversationRows).mockResolvedValue([
      row('s_locked', 'Brandschutz Vertrag'),
      row('s_open', 'Brandschutz Stiege', null),
    ])
    vi.mocked(lockedConversationIds).mockResolvedValue(new Set(['s_locked']))

    const found = await searchConversations(session, reach(), 'Brandschutz', {
      limit: 10,
      offset: 0,
    })

    expect(searchConversationRows).toHaveBeenCalledWith(
      'org_1',
      'user_me',
      { projectIds: [P1, P2], withoutContainer: true },
      'Brandschutz',
      ['fire_safety']
    )
    expect(lockedConversationIds).toHaveBeenCalledWith(session, [
      { id: 's_locked', projectId: P1 },
      { id: 's_open', projectId: null },
    ])
    expect(found).toEqual({
      total: 1,
      hits: [
        {
          kind: 'conversation',
          id: 's_open',
          title: 'Brandschutz Stiege',
          projectId: null,
          projectName: null,
          updatedAt: '2026-10-01T00:00:00.000Z',
        },
      ],
    })
  })

  it('asks nothing for blank text', async () => {
    expect(await searchConversations(session, reach(), '  ', { limit: 10, offset: 0 })).toEqual({
      hits: [],
      total: 0,
    })
    expect(searchConversationRows).not.toHaveBeenCalled()
  })
})

describe('searchAnnotations', () => {
  const annotation = {
    id: 'a1',
    documentId: 'd1',
    filename: 'EG.pdf',
    displayName: null,
    projectId: P1,
    projectName: 'Wohnbau Hubergasse',
    kind: 'defect',
    status: 'open',
    body: 'Fluchtweg zu schmal',
    matchedReply: 'Die Brandschutztür fehlt noch',
    assigneeUserId: null,
    createdAt: new Date('2026-10-02T00:00:00Z'),
  }

  it('defaults to the live statuses, maps the filters to the reader, and quotes the reply that matched', async () => {
    vi.mocked(searchAnnotationRows).mockResolvedValue({ rows: [annotation], total: 1 })

    const found = await searchAnnotations(
      reach(),
      ' brandschutz ',
      { assignedToMe: true, createdByMe: true },
      { limit: 500, offset: 0 }
    )

    expect(searchAnnotationRows).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 'user_me' }),
      {
        text: 'brandschutz',
        statuses: ['open', 'proposed'],
        kinds: null,
        assigneeUserId: 'user_me',
        createdBy: 'user_me',
      },
      { limit: 100, offset: 0 }
    )
    expect(found.hits[0]).toMatchObject({
      documentName: 'EG.pdf',
      excerpt: 'Die Brandschutztür fehlt noch',
      projectName: 'Wohnbau Hubergasse',
    })
  })

  it('quotes the body when it matched, and lists by filters alone without text', async () => {
    vi.mocked(searchAnnotationRows).mockResolvedValue({
      rows: [{ ...annotation, matchedReply: null }],
      total: 1,
    })
    const found = await searchAnnotations(
      reach(),
      null,
      { statuses: ['resolved'], kinds: ['defect'] },
      { limit: 5, offset: 0 }
    )
    expect(vi.mocked(searchAnnotationRows).mock.calls[0][1]).toMatchObject({
      text: null,
      statuses: ['resolved'],
      kinds: ['defect'],
    })
    expect(found.hits[0].excerpt).toBe('Fluchtweg zu schmal')
  })
})

describe('searchFolders', () => {
  it('maps a row to a hit with the description as excerpt', async () => {
    vi.mocked(searchFolderRows).mockResolvedValue({
      rows: [
        {
          id: 'f1',
          name: 'Verträge',
          description: 'Werkverträge der Fachplaner',
          scope: 'project',
          projectId: P1,
          projectName: 'Wohnbau',
        },
      ],
      total: 1,
    })
    expect(await searchFolders(reach(), 'vertr', { limit: 5, offset: 0 })).toEqual({
      total: 1,
      hits: [
        {
          kind: 'folder',
          id: 'f1',
          name: 'Verträge',
          shelf: 'project',
          projectId: P1,
          projectName: 'Wohnbau',
          excerpt: 'Werkverträge der Fachplaner',
        },
      ],
    })
  })
})
