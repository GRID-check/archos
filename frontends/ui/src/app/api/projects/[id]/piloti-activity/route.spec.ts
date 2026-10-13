/**
 * @vitest-environment node
 */
/**
 * `GET /api/projects/[id]/piloti-activity`, driven through the TYPED CLIENT
 * (`fetchPilotiActivity`, ADR-0055) and the real service: the section and the
 * Overview tile call the same function, so a path, a query parameter or a
 * field the client and the route disagreed on would fail here. The service's
 * repositories and gates are mocked at their seams (`lib/piloti-activity/service.spec.ts`
 * holds its rules, `reads.integration.spec.ts` its SQL).
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('server-only', () => ({}))

const SESSION = vi.hoisted(() => ({
  userId: 'user_me',
  organizationId: 'org_1',
  organizationMembershipId: 'om_1',
  email: 'me@grid.test',
  name: 'Max Muster',
  role: 'member',
  permissions: [] as string[],
}))

vi.mock('@/lib/auth/require-auth', () => ({ requireAuthorizedSession: vi.fn(async () => SESSION) }))
vi.mock('@/lib/authz/projects', () => ({ requireProjectAccess: vi.fn() }))
vi.mock('@/lib/authz/feature-flags', () => ({ isPilotiWakesEnabled: vi.fn(() => true), isSkillsEnabled: vi.fn(() => false) }))
vi.mock('@/lib/projects/service', () => ({
  MEMORY_WRITE_PERMISSIONS: ['project:memory:write', 'project:edit'],
  projectOverviewReader: vi.fn(async () => ({ hiddenFolderIds: [], reader: { kind: 'member', userId: 'user_me' } })),
}))
vi.mock('@/lib/annotations/wake-repository', () => ({ listLiveProjectWakes: vi.fn(), listEndedProjectWakes: vi.fn() }))
vi.mock('@/lib/annotations/repository', () => ({ listProposedMarkDocuments: vi.fn(), listProposedMarkSamples: vi.fn() }))
vi.mock('@/lib/annotations/service', () => ({ mayEditAnnotations: vi.fn(async () => true) }))
vi.mock('@/lib/tasks/repository', () => ({ listActiveRunsInProject: vi.fn(), listFinishedRunsInProject: vi.fn() }))
vi.mock('@/lib/tasks/subject-access', () => ({
  withoutUnreadableSubjects: vi.fn(async (_session: unknown, _project: unknown, rows: unknown[]) => rows),
}))
vi.mock('@/lib/proposals/repository', () => ({ listOpenProposalsInProject: vi.fn(), listDecidedProposalsInProject: vi.fn() }))
vi.mock('@/lib/proposals/kinds', () => ({
  DECIDE_PERMISSIONS: { file_operation: [], memory: [], project_profile: [] },
  parseKindPayload: vi.fn(),
  summaryOf: vi.fn(),
}))
vi.mock('@/lib/changes/repository', () => ({ listRecentTurnChanges: vi.fn() }))
vi.mock('@/lib/conversations/repository', () => ({ listVisibleConversationIds: vi.fn(async () => new Set()) }))
vi.mock('@/lib/conversations/restricted-use', () => ({ lockedConversationIds: vi.fn(async () => new Set()) }))
vi.mock('@/lib/documents/repository', () => ({ listVisibleProjectDocumentNames: vi.fn() }))
vi.mock('@/lib/sharing/directory', () => ({ loadOrganizationDirectory: vi.fn(async () => new Map()) }))

import { NotFoundError } from '@/lib/api/errors'
import { listProposedMarkDocuments, listProposedMarkSamples } from '@/lib/annotations/repository'
import { delegationEventId } from '@/lib/annotations/wake-ids'
import { listEndedProjectWakes, listLiveProjectWakes } from '@/lib/annotations/wake-repository'
import { requireProjectAccess } from '@/lib/authz/projects'
import { listRecentTurnChanges } from '@/lib/changes/repository'
import { listVisibleProjectDocumentNames } from '@/lib/documents/repository'
import { fetchPilotiActivity, PilotiActivityRequestError } from '@/lib/piloti-activity/client'
import { RECENT_DEFAULT_LIMIT } from '@/lib/piloti-activity/types'
import { listDecidedProposalsInProject, listOpenProposalsInProject } from '@/lib/proposals/repository'
import { listActiveRunsInProject, listFinishedRunsInProject } from '@/lib/tasks/repository'
import { GET } from './route'

const PROJECT = '3f2504e0-4f89-11d3-9a0c-0305e82c3301'
const MARK = 'a1a1a1a1-0000-4000-8000-000000000001'
const DELEGATED_AT = new Date('2026-10-13T11:00:00.000Z')

/** The route as a `fetch`: what the browser's client calls, answered by the real handler. */
const run = async (path: string, init?: RequestInit) => {
  const url = new URL(path, 'https://grid.test')
  const matched = /^\/api\/projects\/([^/]+)\/piloti-activity$/.exec(url.pathname)
  if (!matched || (init?.method ?? 'GET') !== 'GET') throw new Error(`no route for ${url.pathname}`)
  return GET(new Request(url, init), { params: Promise.resolve({ id: decodeURIComponent(matched[1]) }) })
}

beforeEach(() => {
  vi.mocked(requireProjectAccess)
    .mockReset()
    .mockResolvedValue({ role: 'project-editor', closed: false, readsBecauseClosed: false })
  for (const read of [
    listLiveProjectWakes,
    listEndedProjectWakes,
    listActiveRunsInProject,
    listFinishedRunsInProject,
    listOpenProposalsInProject,
    listDecidedProposalsInProject,
    listProposedMarkDocuments,
    listProposedMarkSamples,
    listRecentTurnChanges,
    listVisibleProjectDocumentNames,
  ]) {
    vi.mocked(read).mockReset().mockResolvedValue([])
  }
})

describe('GET /api/projects/[id]/piloti-activity through fetchPilotiActivity', () => {
  it('answers the contract the client parses: the sections, the reader and what exists for them', async () => {
    vi.mocked(listLiveProjectWakes).mockResolvedValue([
      {
        id: 'w0000000-0000-4000-8000-000000000001',
        status: 'started',
        triggerKind: 'assigned',
        eventId: delegationEventId(MARK, DELEGATED_AT),
        actorUserId: 'user_me',
        reason: null,
        createdAt: new Date('2026-10-13T11:00:01.000Z'),
        settledAt: new Date('2026-10-13T11:00:05.000Z'),
        endedAt: null,
        documentId: 'd1d1d1d1-0000-4000-8000-000000000001',
        documentFilename: 'Grundriss EG.pdf',
        documentDisplayName: null,
        annotationId: MARK,
        markNumber: 3,
        markKind: 'question',
        markBody: 'Wie breit ist die Stiege?',
        markDelegatedAt: DELEGATED_AT,
      },
    ])
    const view = await fetchPilotiActivity(PROJECT, {}, run)
    expect(view).toMatchObject({
      projectId: PROJECT,
      viewerUserId: 'user_me',
      capabilities: { wakes: true, automation: false },
      running: {
        items: [
          {
            kind: 'wake',
            status: 'started',
            startedAt: '2026-10-13T11:00:05.000Z',
            forPerson: { userId: 'user_me', name: null },
            document: { name: 'Grundriss EG.pdf' },
            mark: { number: 3, kind: 'question', excerpt: 'Wie breit ist die Stiege?' },
            canTakeBack: true,
            turn: null,
          },
        ],
        truncated: false,
      },
      waiting: { items: [], truncated: false },
      recent: { items: [], truncated: false },
    })
    expect(requireProjectAccess).toHaveBeenCalledWith(SESSION, PROJECT, 'project:view')
    expect(listEndedProjectWakes).toHaveBeenCalledWith(expect.anything(), expect.any(Date), RECENT_DEFAULT_LIMIT + 1)
  })

  it('passes `since` and `limit` through, and moves a stale `since` up rather than refusing it', async () => {
    const view = await fetchPilotiActivity(PROJECT, { since: '2020-01-01T00:00:00.000Z', limit: 5 }, run)
    expect(Date.parse(view.recent.since)).toBeGreaterThan(Date.parse('2026-01-01T00:00:00.000Z'))
    expect(listRecentTurnChanges).toHaveBeenCalledWith(expect.anything(), 'user_me', new Date(view.recent.since), 6, 3)
  })

  it('refuses a limit outside its bounds, and a `since` that is not an instant, with a 400', async () => {
    for (const query of [{ limit: 0 }, { limit: 101 }, { since: 'gestern' }]) {
      const refusal = await fetchPilotiActivity(PROJECT, query, run).catch((error: unknown) => error)
      expect(refusal).toBeInstanceOf(PilotiActivityRequestError)
      expect((refusal as PilotiActivityRequestError).status).toBe(400)
    }
    expect(listLiveProjectWakes).not.toHaveBeenCalled()
  })

  it('answers a project the reader may not view with the 404 envelope the client reads', async () => {
    vi.mocked(requireProjectAccess).mockRejectedValue(new NotFoundError())
    const refusal = await fetchPilotiActivity(PROJECT, {}, run).catch((error: unknown) => error)
    expect(refusal).toBeInstanceOf(PilotiActivityRequestError)
    expect(refusal).toMatchObject({ status: 404 })
    expect(listLiveProjectWakes).not.toHaveBeenCalled()
  })
})
