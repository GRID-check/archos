/**
 * @vitest-environment node
 */
/**
 * „Was Piloti tut": the service's own rules, with every repository at its seam.
 *
 * The SQL halves of the gates (a held upload, a document in a closed folder,
 * another project's or a Büroablage document, another person's private or a
 * deleted conversation) are claims about SQL, and live in
 * `./reads.integration.spec.ts` against a real Postgres. What is under test
 * here is that the service hands every document read THIS reader's gate
 * (the reader and the hidden folders the overview uses), asks every bounded
 * read one past its cap, drops what a conversation lock or the Aufträge rule
 * withholds, links a thread only through the link gate, decides each action by
 * the rule its own route uses, merges newest first, and says `truncated`
 * exactly when something was left out. Every response is parsed with the
 * contract's schema.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('server-only', () => ({}))
vi.mock('@/lib/authz/projects', () => ({ requireProjectAccess: vi.fn() }))
vi.mock('@/lib/authz/feature-flags', () => ({ isPilotiWakesEnabled: vi.fn(), isSkillsEnabled: vi.fn() }))
vi.mock('@/lib/projects/service', () => ({
  MEMORY_WRITE_PERMISSIONS: ['project:memory:write', 'project:edit'],
  projectOverviewReader: vi.fn(),
}))
vi.mock('@/lib/annotations/wake-repository', () => ({ listLiveProjectWakes: vi.fn(), listEndedProjectWakes: vi.fn() }))
vi.mock('@/lib/annotations/repository', () => ({ listProposedMarkDocuments: vi.fn(), listProposedMarkSamples: vi.fn() }))
vi.mock('@/lib/annotations/service', () => ({ mayEditAnnotations: vi.fn() }))
vi.mock('@/lib/tasks/repository', () => ({ listActiveRunsInProject: vi.fn(), listFinishedRunsInProject: vi.fn() }))
vi.mock('@/lib/tasks/subject-access', () => ({ withoutUnreadableSubjects: vi.fn() }))
vi.mock('@/lib/proposals/repository', () => ({ listOpenProposalsInProject: vi.fn(), listDecidedProposalsInProject: vi.fn() }))
vi.mock('@/lib/proposals/kinds', async () => {
  const types = await vi.importActual<typeof import('@/lib/proposals/types')>('@/lib/proposals/types')
  return {
    DECIDE_PERMISSIONS: {
      file_operation: ['project:documents:write', 'project:edit'],
      memory: ['project:memory:write', 'project:edit'],
      project_profile: ['project:memory:write', 'project:edit'],
    },
    // The real parse, by the contract's schemas; the summary is the note's words or the title.
    parseKindPayload: (kind: string, payload: unknown) => {
      if (kind === 'memory') return { kind, payload: types.memoryPayloadSchema.parse(payload) }
      if (kind === 'project_profile') return { kind, payload: types.projectProfilePayloadSchema.parse(payload) }
      return { kind, payload: types.fileOperationPayloadSchema.parse(payload) }
    },
    summaryOf: (typed: { kind: string; payload: { content?: string; title?: string } }) =>
      typed.payload.content ?? typed.payload.title ?? 'files',
  }
})
vi.mock('@/lib/changes/repository', () => ({ listRecentTurnChanges: vi.fn() }))
vi.mock('@/lib/conversations/repository', () => ({ listVisibleConversationIds: vi.fn() }))
vi.mock('@/lib/conversations/restricted-use', () => ({ lockedConversationIds: vi.fn() }))
vi.mock('@/lib/documents/repository', () => ({ listVisibleProjectDocumentNames: vi.fn() }))
vi.mock('@/lib/sharing/directory', () => ({ loadOrganizationDirectory: vi.fn() }))

import { ForbiddenError, NotFoundError } from '@/lib/api/errors'
import { listProposedMarkDocuments, listProposedMarkSamples } from '@/lib/annotations/repository'
import { mayEditAnnotations } from '@/lib/annotations/service'
import { delegationEventId, documentThreadConversationId } from '@/lib/annotations/wake-ids'
import { listEndedProjectWakes, listLiveProjectWakes, type ProjectWakeRow } from '@/lib/annotations/wake-repository'
import type { AuthorizedSession } from '@/lib/auth/types'
import { isPilotiWakesEnabled, isSkillsEnabled } from '@/lib/authz/feature-flags'
import { requireProjectAccess, type ProjectAccess } from '@/lib/authz/projects'
import { listRecentTurnChanges, type TurnChangesRow } from '@/lib/changes/repository'
import { listVisibleConversationIds } from '@/lib/conversations/repository'
import { lockedConversationIds } from '@/lib/conversations/restricted-use'
import type { TaskRun } from '@/lib/db/schema'
import type { ProposedChangeRow } from '@/lib/db/schema/proposed-changes'
import { listVisibleProjectDocumentNames } from '@/lib/documents/repository'
import { projectOverviewReader } from '@/lib/projects/service'
import { listDecidedProposalsInProject, listOpenProposalsInProject } from '@/lib/proposals/repository'
import { loadOrganizationDirectory, type DirectoryPerson } from '@/lib/sharing/directory'
import { listActiveRunsInProject, listFinishedRunsInProject } from '@/lib/tasks/repository'
import { withoutUnreadableSubjects } from '@/lib/tasks/subject-access'
import { getPilotiActivity, markExcerpt, mergeNewestFirst, wakeEndReasonKind } from './service'
import {
  MARK_EXCERPT_MAX,
  PILOTI_ACTIVITY_RUNNING_CAP,
  PILOTI_ACTIVITY_WAITING_CAP,
  PROPOSED_MARK_DOCUMENTS_CAP,
  PROPOSED_MARK_SAMPLE,
  RECENT_DEFAULT_LIMIT,
  RECENT_MAX_DAYS,
  pilotiActivityResponseSchema,
  type PilotiActivityResponse,
} from './types'

const NOW = new Date('2026-10-13T12:00:00.000Z')
const minutesAgo = (minutes: number) => new Date(NOW.getTime() - minutes * 60_000)
const DAY_MS = 24 * 60 * 60 * 1000

const ME = 'user_me'
const ANNA = 'user_anna'
const PROJECT = '3f2504e0-4f89-11d3-9a0c-0305e82c3301'
const SESSION = {
  userId: ME,
  organizationId: 'org_1',
  organizationMembershipId: 'om_1',
  email: 'me@grid.test',
  role: 'member',
  permissions: [],
} as unknown as AuthorizedSession
const READER = { kind: 'member', userId: ME } as const
const HIDDEN = ['folder_closed']

const DOC = 'd1d1d1d1-0000-4000-8000-000000000001'
const DOC_2 = 'd2d2d2d2-0000-4000-8000-000000000002'
const MARK = 'a1a1a1a1-0000-4000-8000-000000000001'
const DELEGATED_AT = minutesAgo(30)

const access = (extra: Partial<ProjectAccess> = {}): ProjectAccess => ({
  role: 'project-editor',
  closed: false,
  readsBecauseClosed: false,
  ...extra,
})

function wakeRow(extra: Partial<ProjectWakeRow> = {}): ProjectWakeRow {
  const annotationId = extra.annotationId ?? MARK
  return {
    id: 'w0000000-0000-4000-8000-000000000001',
    status: 'queued',
    triggerKind: 'assigned',
    eventId: delegationEventId(annotationId, DELEGATED_AT),
    actorUserId: ANNA,
    reason: null,
    createdAt: minutesAgo(5),
    settledAt: null,
    endedAt: null,
    documentId: DOC,
    documentFilename: 'Grundriss EG.pdf',
    documentDisplayName: null,
    annotationId,
    markNumber: 4,
    markKind: 'defect',
    markBody: 'Tür fehlt',
    markDelegatedAt: DELEGATED_AT,
    ...extra,
  }
}

function runRow(extra: Partial<TaskRun> = {}): TaskRun {
  return {
    id: 'r0000000-0000-4000-8000-000000000001',
    organizationId: 'org_1',
    projectId: PROJECT,
    definitionId: null,
    kind: 'deep-research',
    title: 'Recherche Stellplätze',
    plan: { prompt: 'Recherchiere', skill: {}, dataSources: null },
    requesterUserId: ANNA,
    requesterEmail: null,
    trigger: 'manual',
    triggeredBy: ANNA,
    status: 'running',
    error: null,
    skillSnapshot: {},
    backendJobId: 'job_1',
    conversationId: 'conv_run',
    runMessageId: 'm0000000-0000-4000-8000-000000000001',
    filedDocumentId: null,
    filingStatus: null,
    filingDetail: null,
    review: null,
    reviewReason: null,
    reviewedBy: null,
    reviewedAt: null,
    createdAt: minutesAgo(10),
    startedAt: minutesAgo(9),
    finishedAt: null,
    updatedAt: minutesAgo(9),
    reconcileCheckedAt: null,
    ...extra,
  } as TaskRun
}

function proposalRow(extra: Partial<ProposedChangeRow> = {}): ProposedChangeRow {
  return {
    id: 'p0000000-0000-4000-8000-000000000001',
    organizationId: 'org_1',
    projectId: PROJECT,
    kind: 'memory',
    payload: { scope: 'project', kind: 'decision', content: 'Flachdach', confidence: 'high' },
    status: 'proposed',
    proposedByKind: 'piloti',
    onBehalfOf: ANNA,
    originConversationId: 'conv_open',
    originMessageId: 'c0000000-0000-4000-8000-000000000001',
    originCardIndex: 0,
    createdAt: minutesAgo(8),
    decidedBy: null,
    decidedAt: null,
    results: null,
    applyingBy: null,
    applyingSince: null,
    ...extra,
  }
}

function changesRow(extra: Partial<TurnChangesRow> = {}): TurnChangesRow {
  return {
    conversationId: 'conv_open',
    messageId: 'c0000000-0000-4000-8000-000000000009',
    count: 3,
    undoneCount: 1,
    newestAt: minutesAgo(7),
    onBehalfOf: ME,
    documentCount: 2,
    documentIds: [DOC, DOC_2],
    ...extra,
  }
}

const directory = new Map<string, DirectoryPerson>([
  [ME, { userId: ME, email: 'me@grid.test', name: 'Max Muster', profilePictureUrl: null }],
  [ANNA, { userId: ANNA, email: 'anna@grid.test', name: 'Anna Berger', profilePictureUrl: null }],
])

const read = async (query: { since?: string; limit?: number } = {}): Promise<PilotiActivityResponse> =>
  pilotiActivityResponseSchema.parse(
    await getPilotiActivity(SESSION, PROJECT, { limit: query.limit ?? RECENT_DEFAULT_LIMIT, since: query.since })
  )

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(NOW)
  vi.mocked(requireProjectAccess).mockReset().mockResolvedValue(access())
  vi.mocked(projectOverviewReader).mockReset().mockResolvedValue({ hiddenFolderIds: HIDDEN, reader: READER })
  vi.mocked(isPilotiWakesEnabled).mockReset().mockReturnValue(true)
  vi.mocked(isSkillsEnabled).mockReset().mockReturnValue(true)
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
  vi.mocked(withoutUnreadableSubjects).mockReset().mockImplementation(async (_session, _project, rows) => [...rows])
  vi.mocked(mayEditAnnotations).mockReset().mockResolvedValue(true)
  vi.mocked(listVisibleConversationIds).mockReset().mockImplementation(async (_o, _u, _p, ids) => new Set(ids))
  vi.mocked(lockedConversationIds).mockReset().mockResolvedValue(new Set())
  vi.mocked(loadOrganizationDirectory).mockReset().mockResolvedValue(directory)
})

afterEach(() => {
  vi.useRealTimers()
})

describe('entry', () => {
  it('answers a project the reader may not view with its 404, and reads nothing', async () => {
    vi.mocked(requireProjectAccess).mockRejectedValueOnce(new NotFoundError())
    await expect(read()).rejects.toBeInstanceOf(NotFoundError)
    expect(requireProjectAccess).toHaveBeenCalledWith(SESSION, PROJECT, 'project:view')
    expect(projectOverviewReader).not.toHaveBeenCalled()
    expect(listLiveProjectWakes).not.toHaveBeenCalled()
  })

  it("hands every document read this reader's gate: the held-upload reader and the closed folders", async () => {
    vi.mocked(listProposedMarkDocuments).mockResolvedValue([
      { documentId: DOC, filename: 'a.pdf', displayName: null, count: 1, newestAt: minutesAgo(1) },
    ])
    vi.mocked(listRecentTurnChanges).mockResolvedValue([changesRow()])
    await read()
    const gate = { organizationId: 'org_1', projectId: PROJECT, reader: READER, hiddenFolderIds: HIDDEN }
    expect(projectOverviewReader).toHaveBeenCalledWith(SESSION, PROJECT)
    expect(listLiveProjectWakes).toHaveBeenCalledWith(gate, expect.any(Number))
    expect(listEndedProjectWakes).toHaveBeenCalledWith(gate, expect.any(Date), expect.any(Number))
    expect(listProposedMarkDocuments).toHaveBeenCalledWith(gate, expect.any(Number))
    expect(listProposedMarkSamples).toHaveBeenCalledWith(gate, [DOC], PROPOSED_MARK_SAMPLE)
    expect(listRecentTurnChanges).toHaveBeenCalledWith(gate, ME, expect.any(Date), expect.any(Number), 3)
    expect(listVisibleProjectDocumentNames).toHaveBeenCalledWith(gate, [DOC, DOC_2])
    const reader = { organizationId: 'org_1', projectId: PROJECT, userId: ME }
    expect(listOpenProposalsInProject).toHaveBeenCalledWith(reader, expect.any(Number))
    expect(listDecidedProposalsInProject).toHaveBeenCalledWith(reader, expect.any(Date), expect.any(Number))
  })

  it('asks every source one past its cap, and the recent ones one past the limit', async () => {
    await read({ limit: 7 })
    expect(listLiveProjectWakes).toHaveBeenCalledWith(expect.anything(), PILOTI_ACTIVITY_RUNNING_CAP + 1)
    expect(listActiveRunsInProject).toHaveBeenCalledWith(PROJECT, 'org_1', PILOTI_ACTIVITY_RUNNING_CAP + 1)
    expect(listOpenProposalsInProject).toHaveBeenCalledWith(expect.anything(), PILOTI_ACTIVITY_WAITING_CAP + 1)
    expect(listProposedMarkDocuments).toHaveBeenCalledWith(expect.anything(), PROPOSED_MARK_DOCUMENTS_CAP + 1)
    expect(listEndedProjectWakes).toHaveBeenCalledWith(expect.anything(), expect.any(Date), 8)
    expect(listFinishedRunsInProject).toHaveBeenCalledWith(PROJECT, 'org_1', expect.any(Date), 8)
    expect(listDecidedProposalsInProject).toHaveBeenCalledWith(expect.anything(), expect.any(Date), 8)
    expect(listRecentTurnChanges).toHaveBeenCalledWith(expect.anything(), ME, expect.any(Date), 8, 3)
  })

  it('reads `recent` from the clamped `since`: the default, a recent one, and one older than the furthest back', async () => {
    const asked = () => vi.mocked(listEndedProjectWakes).mock.lastCall?.[1]
    const none = await read()
    expect(none.recent.since).toBe(new Date(NOW.getTime() - 14 * DAY_MS).toISOString())
    expect(asked()).toEqual(new Date(none.recent.since))
    const recent = await read({ since: minutesAgo(90).toISOString() })
    expect(recent.recent.since).toBe(minutesAgo(90).toISOString())
    const stale = await read({ since: new Date(NOW.getTime() - 90 * DAY_MS).toISOString() })
    expect(stale.recent.since).toBe(new Date(NOW.getTime() - RECENT_MAX_DAYS * DAY_MS).toISOString())
    expect(asked()).toEqual(new Date(stale.recent.since))
    expect(vi.mocked(listDecidedProposalsInProject).mock.lastCall?.[1]).toEqual(asked())
    expect(vi.mocked(listFinishedRunsInProject).mock.lastCall?.[2]).toEqual(asked())
  })

  it('names the viewer, when it was read, and what exists for the reader', async () => {
    vi.mocked(isPilotiWakesEnabled).mockReturnValue(false)
    const view = await read()
    expect(view).toMatchObject({
      projectId: PROJECT,
      viewerUserId: ME,
      generatedAt: NOW.toISOString(),
      capabilities: { wakes: false, automation: true },
      running: { items: [], truncated: false },
      waiting: { items: [], truncated: false },
      recent: { items: [], truncated: false },
    })
  })
})

describe('running', () => {
  it('lists a live wake with its mark, its person and its review target', async () => {
    vi.mocked(listLiveProjectWakes).mockResolvedValue([wakeRow({ documentDisplayName: 'Grundriss Erdgeschoss' })])
    const [row] = (await read()).running.items
    expect(row).toEqual({
      kind: 'wake',
      id: 'w0000000-0000-4000-8000-000000000001',
      at: minutesAgo(5).toISOString(),
      status: 'queued',
      startedAt: null,
      trigger: 'assigned',
      forPerson: { userId: ANNA, name: 'Anna Berger' },
      document: { id: DOC, name: 'Grundriss Erdgeschoss' },
      mark: { id: MARK, number: 4, kind: 'defect', excerpt: 'Tür fehlt' },
      canTakeBack: true,
      target: { kind: 'review', documentId: DOC, annotationId: MARK },
      turn: {
        kind: 'turn',
        conversationId: documentThreadConversationId(DOC, ANNA),
        messageId: 'w0000000-0000-4000-8000-000000000001',
      },
    })
  })

  it('offers the take-back only for the current delegation, on a document the reader may edit, asked once per document', async () => {
    const id = (n: number) => `w0000000-0000-4000-8000-00000000000${n}`
    vi.mocked(listLiveProjectWakes).mockResolvedValue([
      wakeRow({ id: id(1), status: 'started', settledAt: minutesAgo(4) }),
      wakeRow({ id: id(2), createdAt: minutesAgo(6), triggerKind: 'thread_mention' }),
      wakeRow({ id: id(3), createdAt: minutesAgo(7), eventId: delegationEventId(MARK, minutesAgo(90)) }),
      wakeRow({ id: id(4), createdAt: minutesAgo(8), markDelegatedAt: null }),
      wakeRow({ id: id(5), createdAt: minutesAgo(9), documentId: DOC_2 }),
      wakeRow({ id: id(6), createdAt: minutesAgo(10) }),
    ])
    vi.mocked(mayEditAnnotations).mockImplementation(async (_session, documentId) => documentId === DOC)
    const items = (await read()).running.items
    expect(items.map((row) => row.kind === 'wake' && [row.id, row.canTakeBack])).toEqual([
      [id(1), true],
      [id(2), false],
      [id(3), false],
      [id(4), false],
      [id(5), false],
      [id(6), true],
    ])
    expect(items[0]).toMatchObject({ status: 'started', startedAt: minutesAgo(4).toISOString() })
    expect(vi.mocked(mayEditAnnotations).mock.calls.map(([, documentId]) => documentId).sort()).toEqual([DOC, DOC_2].sort())
  })

  it('reads a refused write check as no take-back, and lets any other failure through', async () => {
    vi.mocked(listLiveProjectWakes).mockResolvedValue([wakeRow()])
    vi.mocked(mayEditAnnotations).mockRejectedValueOnce(new NotFoundError())
    expect((await read()).running.items[0]).toMatchObject({ canTakeBack: false })
    vi.mocked(mayEditAnnotations).mockRejectedValueOnce(new Error('database down'))
    await expect(read()).rejects.toThrow('database down')
  })

  it("links a wake's turn only when its person's thread passes the link gate and is not locked", async () => {
    vi.mocked(listLiveProjectWakes).mockResolvedValue([
      wakeRow(),
      wakeRow({ id: 'w0000000-0000-4000-8000-000000000002', actorUserId: ME, createdAt: minutesAgo(6) }),
      wakeRow({ id: 'w0000000-0000-4000-8000-000000000003', actorUserId: 'user_3', createdAt: minutesAgo(7) }),
    ])
    const annas = documentThreadConversationId(DOC, ANNA)
    const mine = documentThreadConversationId(DOC, ME)
    vi.mocked(listVisibleConversationIds).mockResolvedValue(new Set([annas, mine]))
    vi.mocked(lockedConversationIds).mockResolvedValue(new Set([mine]))
    const items = (await read()).running.items
    expect(items.map((row) => row.kind === 'wake' && row.turn?.conversationId)).toEqual([annas, undefined, undefined])
    expect(listVisibleConversationIds).toHaveBeenCalledWith('org_1', ME, PROJECT, [
      annas,
      mine,
      documentThreadConversationId(DOC, 'user_3'),
    ])
    expect(lockedConversationIds).toHaveBeenCalledWith(SESSION, [
      { id: annas, projectId: PROJECT },
      { id: mine, projectId: PROJECT },
    ])
  })

  it('lists a run with its stop and its block, and asks the Aufträge rule about it', async () => {
    vi.mocked(listActiveRunsInProject).mockResolvedValue([runRow()])
    const [row] = (await read()).running.items
    expect(row).toEqual({
      kind: 'run',
      id: 'r0000000-0000-4000-8000-000000000001',
      at: minutesAgo(10).toISOString(),
      status: 'running',
      startedAt: minutesAgo(9).toISOString(),
      taskKind: 'deep-research',
      title: 'Recherche Stellplätze',
      forPerson: { userId: ANNA, name: 'Anna Berger' },
      canStop: true,
      target: {
        kind: 'run',
        conversationId: 'conv_run',
        messageId: 'm0000000-0000-4000-8000-000000000001',
        runId: 'r0000000-0000-4000-8000-000000000001',
      },
    })
    expect(requireProjectAccess).toHaveBeenCalledWith(SESSION, PROJECT, ['project:chat', 'project:edit'])
  })

  it('leaves out a run whose subject the reader may not read', async () => {
    vi.mocked(listActiveRunsInProject).mockResolvedValue([runRow()])
    vi.mocked(withoutUnreadableSubjects).mockResolvedValue([])
    expect((await read()).running.items).toEqual([])
  })

  it('stops a run only as `requireRunActor` would: chat, not read only because closed unless it is theirs, and a job', async () => {
    const mine = runRow({ id: 'r0000000-0000-4000-8000-000000000002', requesterUserId: ME, createdAt: minutesAgo(11) })
    const jobless = runRow({ id: 'r0000000-0000-4000-8000-000000000003', backendJobId: null, createdAt: minutesAgo(12) })
    vi.mocked(listActiveRunsInProject).mockResolvedValue([runRow(), mine, jobless])
    const stops = async () => (await read()).running.items.map((row) => row.kind === 'run' && row.canStop)

    expect(await stops()).toEqual([true, true, false])
    vi.mocked(requireProjectAccess).mockImplementation(async (_s, _p, permission) =>
      permission === 'project:view' ? access() : access({ closed: true, readsBecauseClosed: true })
    )
    expect(await stops()).toEqual([false, true, false])
    vi.mocked(requireProjectAccess).mockImplementation(async (_s, _p, permission) => {
      if (permission === 'project:view') return access()
      throw new NotFoundError()
    })
    expect(await stops()).toEqual([false, false, false])
  })

  it("points a run at its drawer when its thread is closed to the reader, and nowhere without Automation", async () => {
    vi.mocked(listActiveRunsInProject).mockResolvedValue([runRow(), runRow({ id: 'r0000000-0000-4000-8000-000000000002', conversationId: null, createdAt: minutesAgo(11) })])
    vi.mocked(listVisibleConversationIds).mockResolvedValue(new Set())
    expect((await read()).running.items.map((row) => row.kind === 'run' && row.target)).toEqual([
      { kind: 'task', taskId: 'r0000000-0000-4000-8000-000000000001' },
      { kind: 'task', taskId: 'r0000000-0000-4000-8000-000000000002' },
    ])
    vi.mocked(isSkillsEnabled).mockReturnValue(false)
    expect((await read()).running.items.map((row) => row.kind === 'run' && row.target)).toEqual([null, null])
  })

  it('merges wakes and runs newest first, ties by id, and cuts at the cap with truncated', async () => {
    vi.mocked(listLiveProjectWakes).mockResolvedValue([
      wakeRow({ id: 'w0000000-0000-4000-8000-00000000000a', createdAt: minutesAgo(3) }),
      wakeRow({ id: 'w0000000-0000-4000-8000-00000000000b', createdAt: minutesAgo(10) }),
    ])
    vi.mocked(listActiveRunsInProject).mockResolvedValue([runRow({ createdAt: minutesAgo(5) })])
    const view = await read()
    expect(view.running.items.map((row) => row.id)).toEqual([
      'w0000000-0000-4000-8000-00000000000a',
      'r0000000-0000-4000-8000-000000000001',
      'w0000000-0000-4000-8000-00000000000b',
    ])
    expect(view.running.truncated).toBe(false)

    const wakes = Array.from({ length: 30 }, (_, n) =>
      wakeRow({ id: `w${String(n).padStart(7, '0')}-0000-4000-8000-000000000000`, createdAt: minutesAgo(n) })
    )
    const runs = Array.from({ length: 30 }, (_, n) =>
      runRow({ id: `r${String(n).padStart(7, '0')}-0000-4000-8000-000000000000`, createdAt: minutesAgo(n) })
    )
    vi.mocked(listLiveProjectWakes).mockResolvedValue(wakes)
    vi.mocked(listActiveRunsInProject).mockResolvedValue(runs)
    const full = await read()
    expect(full.running.items).toHaveLength(PILOTI_ACTIVITY_RUNNING_CAP)
    expect(full.running.truncated).toBe(true)
    // Ties at the same instant: the higher id first.
    expect(full.running.items.slice(0, 2).map((row) => row.id)).toEqual([wakes[0].id, runs[0].id])
  })

  it('says truncated when a source had one past its cap, and shows only the cap', async () => {
    vi.mocked(listActiveRunsInProject).mockResolvedValue(
      Array.from({ length: PILOTI_ACTIVITY_RUNNING_CAP + 1 }, (_, n) =>
        runRow({ id: `r${String(n).padStart(7, '0')}-0000-4000-8000-000000000000`, createdAt: minutesAgo(n) })
      )
    )
    const view = await read()
    expect(view.running.items).toHaveLength(PILOTI_ACTIVITY_RUNNING_CAP)
    expect(view.running.truncated).toBe(true)
    vi.mocked(listActiveRunsInProject).mockResolvedValue([runRow()])
    expect((await read()).running.truncated).toBe(false)
  })
})

describe('waiting', () => {
  it('lists a proposal with its summary, its person, its decision right and its card', async () => {
    vi.mocked(listOpenProposalsInProject).mockResolvedValue([
      proposalRow(),
      proposalRow({
        id: 'p0000000-0000-4000-8000-000000000002',
        kind: 'project_profile',
        payload: { title: 'Bundesland', patch: [{ op: 'replace', path: '/facts/bundesland/value', value: 'tirol' }] },
        originConversationId: null,
        originMessageId: null,
        createdAt: minutesAgo(9),
      }),
    ])
    vi.mocked(requireProjectAccess).mockImplementation(async (_s, _p, permission) => {
      if (Array.isArray(permission) && permission.includes('project:memory:write')) throw new ForbiddenError('closed')
      return access()
    })
    const items = (await read()).waiting.items
    expect(items).toEqual([
      {
        kind: 'proposal',
        id: 'p0000000-0000-4000-8000-000000000001',
        at: minutesAgo(8).toISOString(),
        proposalKind: 'memory',
        summary: 'Flachdach',
        forPerson: { userId: ANNA, name: 'Anna Berger' },
        canDecide: false,
        target: { kind: 'turn', conversationId: 'conv_open', messageId: 'c0000000-0000-4000-8000-000000000001' },
      },
      expect.objectContaining({ proposalKind: 'project_profile', summary: 'Bundesland', target: { kind: 'project_chat' } }),
    ])
  })

  it('asks the decision right once per kind present', async () => {
    vi.mocked(listOpenProposalsInProject).mockResolvedValue([
      proposalRow(),
      proposalRow({ id: 'p0000000-0000-4000-8000-000000000002', createdAt: minutesAgo(9) }),
      proposalRow({
        id: 'p0000000-0000-4000-8000-000000000003',
        kind: 'file_operation',
        payload: { operation: 'create_folder', operations: [{ folder_name: 'Statik' }] },
        createdAt: minutesAgo(10),
      }),
    ])
    const items = (await read()).waiting.items
    expect(items.map((row) => row.kind === 'proposal' && row.canDecide)).toEqual([true, true, true])
    const asked = vi.mocked(requireProjectAccess).mock.calls.map(([, , permission]) => permission)
    expect(asked).toEqual(['project:view', ['project:memory:write', 'project:edit'], ['project:documents:write', 'project:edit']])
  })

  it('drops a proposal whose conversation is locked for the reader, and one whose payload does not parse (logged)', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    vi.mocked(listOpenProposalsInProject).mockResolvedValue([
      proposalRow(),
      proposalRow({ id: 'p0000000-0000-4000-8000-000000000002', originConversationId: 'conv_locked' }),
      proposalRow({ id: 'p0000000-0000-4000-8000-000000000003', payload: { scope: 'nowhere' } }),
    ])
    vi.mocked(lockedConversationIds).mockResolvedValue(new Set(['conv_locked']))
    const items = (await read()).waiting.items
    expect(items.map((row) => row.id)).toEqual(['p0000000-0000-4000-8000-000000000001'])
    expect(lockedConversationIds).toHaveBeenCalledWith(
      SESSION,
      expect.arrayContaining([
        { id: 'conv_open', projectId: PROJECT },
        { id: 'conv_locked', projectId: PROJECT },
      ])
    )
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('p0000000-0000-4000-8000-000000000003'), expect.anything())
    warn.mockRestore()
  })

  it("lists one row per document with Piloti's proposed marks, its first ones by number, newest document first", async () => {
    vi.mocked(listProposedMarkDocuments).mockResolvedValue([
      { documentId: DOC_2, filename: 'Schnitt.pdf', displayName: null, count: 1, newestAt: minutesAgo(2) },
      { documentId: DOC, filename: 'Grundriss.pdf', displayName: 'Grundriss EG', count: 5, newestAt: minutesAgo(20) },
    ])
    const mark = (id: string, documentId: string, number: number) => ({
      id,
      documentId,
      number,
      kind: 'hint' as const,
      body: 'x '.repeat(150),
      page: 3,
      createdBy: ME,
      createdAt: minutesAgo(20),
    })
    vi.mocked(listProposedMarkSamples).mockResolvedValue([
      mark('m3', DOC, 7),
      mark('m1', DOC, 2),
      mark('m2', DOC, 5),
      mark('m4', DOC_2, 1),
    ])
    const items = (await read()).waiting.items
    expect(items.map((row) => row.kind === 'proposed_marks' && [row.id, row.count, row.marks.map((m) => m.number)])).toEqual([
      [DOC_2, 1, [1]],
      [DOC, 5, [2, 5, 7]],
    ])
    expect(items[1]).toMatchObject({
      at: minutesAgo(20).toISOString(),
      document: { id: DOC, name: 'Grundriss EG' },
      target: { kind: 'review', documentId: DOC, annotationId: 'm1' },
      marks: [expect.objectContaining({ page: 3, forPerson: { userId: ME, name: 'Max Muster' } }), expect.anything(), expect.anything()],
    })
    const excerpt = items[1].kind === 'proposed_marks' ? items[1].marks[0].excerpt : ''
    expect(excerpt.length).toBeLessThanOrEqual(MARK_EXCERPT_MAX)
    expect(excerpt.endsWith('…')).toBe(true)
  })

  it('skips a document whose proposals went between the reads, and says truncated past the documents cap', async () => {
    vi.mocked(listProposedMarkDocuments).mockResolvedValue(
      Array.from({ length: PROPOSED_MARK_DOCUMENTS_CAP + 1 }, (_, n) => ({
        documentId: `doc_${n}`,
        filename: `${n}.pdf`,
        displayName: null,
        count: 1,
        newestAt: minutesAgo(n),
      }))
    )
    vi.mocked(listProposedMarkSamples).mockImplementation(async (_gate, documentIds) =>
      documentIds.slice(1).map((documentId, n) => ({
        id: `m_${documentId}`,
        documentId,
        number: 1,
        kind: 'hint' as const,
        body: 'b',
        page: 1,
        createdBy: ME,
        createdAt: minutesAgo(n),
      }))
    )
    const view = await read()
    expect(vi.mocked(listProposedMarkSamples).mock.lastCall?.[1]).toHaveLength(PROPOSED_MARK_DOCUMENTS_CAP)
    expect(view.waiting.items).toHaveLength(PROPOSED_MARK_DOCUMENTS_CAP - 1)
    expect(view.waiting.items.map((row) => row.id)).not.toContain('doc_0')
    expect(view.waiting.truncated).toBe(true)
  })
})

describe('recent', () => {
  it('lists an ended wake by when it ended, a failed or refused one with its reason and its class', async () => {
    vi.mocked(listEndedProjectWakes).mockResolvedValue([
      wakeRow({ status: 'answered', endedAt: minutesAgo(1), settledAt: minutesAgo(3) }),
      wakeRow({
        id: 'w0000000-0000-4000-8000-000000000002',
        status: 'refused',
        reason: 'budget: The organization LLM budget is exhausted.',
        endedAt: minutesAgo(2),
      }),
      wakeRow({ id: 'w0000000-0000-4000-8000-000000000003', status: 'failed', reason: 'gave up waiting: socket 1006', endedAt: minutesAgo(3) }),
    ])
    const items = (await read()).recent.items
    expect(items.map((row) => row.kind === 'wake_ended' && [row.status, row.reason, row.reasonKind, row.at])).toEqual([
      ['answered', null, null, minutesAgo(1).toISOString()],
      ['refused', 'budget: The organization LLM budget is exhausted.', 'budget', minutesAgo(2).toISOString()],
      ['failed', 'gave up waiting: socket 1006', 'busy', minutesAgo(3).toISOString()],
    ])
    expect(items[0]).toMatchObject({ target: { kind: 'review', documentId: DOC, annotationId: MARK } })
  })

  it('lists a finished run with its error and the filed document the gate names', async () => {
    vi.mocked(listFinishedRunsInProject).mockResolvedValue([
      runRow({ status: 'succeeded', finishedAt: minutesAgo(4), filedDocumentId: DOC }),
      runRow({
        id: 'r0000000-0000-4000-8000-000000000002',
        status: 'skipped',
        error: 'Projekt pausiert',
        finishedAt: null,
        updatedAt: minutesAgo(6),
        filedDocumentId: DOC_2,
      }),
    ])
    vi.mocked(listVisibleProjectDocumentNames).mockResolvedValue([{ id: DOC, filename: 'Bericht.pdf', displayName: null }])
    const items = (await read()).recent.items
    expect(items).toEqual([
      expect.objectContaining({
        kind: 'run_finished',
        at: minutesAgo(4).toISOString(),
        status: 'succeeded',
        error: null,
        filedDocument: { id: DOC, name: 'Bericht.pdf' },
      }),
      expect.objectContaining({ at: minutesAgo(6).toISOString(), status: 'skipped', error: 'Projekt pausiert', filedDocument: null }),
    ])
    expect(listVisibleProjectDocumentNames).toHaveBeenCalledWith(expect.anything(), [DOC, DOC_2])
  })

  it("lists a turn's changes, naming only the documents the gate names, and drops a locked thread's", async () => {
    vi.mocked(listRecentTurnChanges).mockResolvedValue([
      changesRow(),
      changesRow({ conversationId: 'conv_locked', messageId: 'c0000000-0000-4000-8000-00000000000a' }),
      changesRow({ messageId: 'c0000000-0000-4000-8000-00000000000b', documentIds: [DOC_2], documentCount: 1 }),
    ])
    vi.mocked(listVisibleProjectDocumentNames).mockResolvedValue([{ id: DOC, filename: 'EG.pdf', displayName: null }])
    vi.mocked(lockedConversationIds).mockResolvedValue(new Set(['conv_locked']))
    const items = (await read()).recent.items
    expect(items).toEqual([
      {
        kind: 'changes',
        id: 'conv_open:c0000000-0000-4000-8000-000000000009',
        at: minutesAgo(7).toISOString(),
        count: 3,
        undoneCount: 1,
        documents: [{ id: DOC, name: 'EG.pdf' }],
        documentCount: 2,
        forPerson: { userId: ME, name: 'Max Muster' },
        target: { kind: 'turn', conversationId: 'conv_open', messageId: 'c0000000-0000-4000-8000-000000000009' },
      },
    ])
  })

  it('lists a decided proposal with who decided, how, and for whom, under the same gates as the open ones', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    vi.mocked(listDecidedProposalsInProject).mockResolvedValue([
      proposalRow({ status: 'applied', decidedBy: ME, decidedAt: minutesAgo(2), results: [] }),
      proposalRow({
        id: 'p0000000-0000-4000-8000-000000000002',
        status: 'dismissed',
        decidedBy: 'user_gone',
        decidedAt: minutesAgo(3),
        originConversationId: null,
        originMessageId: null,
      }),
      proposalRow({ id: 'p0000000-0000-4000-8000-000000000003', status: 'partially_applied', decidedBy: ME, decidedAt: minutesAgo(4), originConversationId: 'conv_locked' }),
      proposalRow({ id: 'p0000000-0000-4000-8000-000000000004', status: 'failed', decidedBy: ME, decidedAt: minutesAgo(5), payload: {} }),
    ])
    vi.mocked(lockedConversationIds).mockResolvedValue(new Set(['conv_locked']))
    const items = (await read()).recent.items
    expect(items).toEqual([
      {
        kind: 'proposal_decided',
        id: 'p0000000-0000-4000-8000-000000000001',
        at: minutesAgo(2).toISOString(),
        proposalKind: 'memory',
        status: 'applied',
        summary: 'Flachdach',
        forPerson: { userId: ANNA, name: 'Anna Berger' },
        decidedBy: { userId: ME, name: 'Max Muster' },
        target: { kind: 'turn', conversationId: 'conv_open', messageId: 'c0000000-0000-4000-8000-000000000001' },
      },
      expect.objectContaining({
        status: 'dismissed',
        decidedBy: { userId: 'user_gone', name: null },
        target: { kind: 'project_chat' },
      }),
    ])
    warn.mockRestore()
  })

  it('merges the four sources newest first and keeps the limit, truncated when cut', async () => {
    vi.mocked(listEndedProjectWakes).mockResolvedValue([wakeRow({ status: 'answered', endedAt: minutesAgo(1) })])
    vi.mocked(listFinishedRunsInProject).mockResolvedValue([runRow({ status: 'succeeded', finishedAt: minutesAgo(4) })])
    vi.mocked(listRecentTurnChanges).mockResolvedValue([changesRow({ newestAt: minutesAgo(3) })])
    vi.mocked(listVisibleProjectDocumentNames).mockResolvedValue([{ id: DOC, filename: 'EG.pdf', displayName: null }])
    vi.mocked(listDecidedProposalsInProject).mockResolvedValue([
      proposalRow({ status: 'dismissed', decidedBy: ME, decidedAt: minutesAgo(2) }),
    ])
    const all = await read()
    expect(all.recent.items.map((row) => row.kind)).toEqual(['wake_ended', 'proposal_decided', 'changes', 'run_finished'])
    expect(all.recent.truncated).toBe(false)
    const cut = await read({ limit: 2 })
    expect(cut.recent.items.map((row) => row.kind)).toEqual(['wake_ended', 'proposal_decided'])
    expect(cut.recent.truncated).toBe(true)
  })

  it('says truncated when one source read past the limit', async () => {
    vi.mocked(listEndedProjectWakes).mockResolvedValue([
      wakeRow({ status: 'answered', endedAt: minutesAgo(1) }),
      wakeRow({ id: 'w0000000-0000-4000-8000-000000000002', status: 'answered', endedAt: minutesAgo(2) }),
    ])
    const view = await read({ limit: 1 })
    expect(view.recent.items).toHaveLength(1)
    expect(view.recent.truncated).toBe(true)
  })
})

describe('wakeEndReasonKind', () => {
  it.each([
    // The wake job (`lib/annotations/wake-job.ts`).
    ['refused', 'budget: The project LLM budget is exhausted. An org admin can raise limits under Organization → Usage & budgets.', 'budget'],
    ['refused', 'budget: The null LLM budget is exhausted.', 'budget'],
    ['failed', 'gave up waiting: another turn of the thread ran', 'busy'],
    ['failed', 'gave up waiting: the thread is being deleted', 'busy'],
    ['failed', 'gave up waiting: no answer in time', 'busy'],
    ['failed', 'gave up waiting: socket 1006', 'busy'],
    ['failed', 'gave up waiting: the server does not read user_message.if_idle', 'busy'],
    ['failed', 'gave up waiting: the socket would not take the message', 'busy'],
    ['failed', 'rejected: auth_expired', 'access'],
    ['failed', 'rejected: conversation_mismatch', 'access'],
    ['failed', 'rejected: invalid_message', 'error'],
    ['failed', 'rejected: invalid_message (Unknown message type.)', 'error'],
    // The refusal's own words, from the job (refused) or the turn's outcome (failed).
    ['refused', "The organization's LLM budget is exhausted (limit scope: organization). An org admin can raise limits under Organization → Usage & budgets.", 'budget'],
    ['failed', "The organization's LLM budget is exhausted (limit scope: user). An org admin can raise limits under Organization → Usage & budgets.", 'budget'],
    ['refused', 'The assistant is busy right now. Please send your message again in a moment.', 'busy'],
    ['failed', 'Your organization already has several answers in progress. Please wait for one to finish.', 'busy'],
    ['refused', 'refused', 'error'],
    // `RUN_ERROR` messages (the chat socket's `_error_for`), and the outcome's fallbacks.
    ['failed', 'auth_error', 'access'],
    ['failed', 'token_expired', 'access'],
    ['failed', 'token_invalid', 'access'],
    ['failed', 'The question was not answered in time.', 'error'],
    ['failed', 'The answer took too long and was stopped. Please ask again, perhaps more narrowly.', 'error'],
    ['failed', 'The assistant hit an unexpected error while handling your request. Please try again.', 'error'],
    ['failed', 'The turn ended without a result.', 'error'],
    ['failed', 'failed', 'error'],
    ['failed', 'the turn ended without an answer', 'error'],
    ['failed', 'something nobody wrote down yet', 'error'],
  ] as const)('%s „%s" is %s', (status, reason, kind) => {
    expect(wakeEndReasonKind(status, reason)).toBe(kind)
  })

  it('is null exactly when there is no reason to classify', () => {
    expect(wakeEndReasonKind('answered', null)).toBeNull()
    expect(wakeEndReasonKind('stopped', null)).toBeNull()
    expect(wakeEndReasonKind('failed', null)).toBeNull()
    expect(wakeEndReasonKind('refused', '  ')).toBeNull()
  })
})

describe('markExcerpt', () => {
  it('keeps a short text whole, on one line', () => {
    expect(markExcerpt('  Tür\n fehlt  ')).toBe('Tür fehlt')
  })

  it('cuts a long text at a word, with „…", within the bound', () => {
    const cut = markExcerpt(`${'Wort '.repeat(60)}Ende`)
    expect(cut.length).toBeLessThanOrEqual(MARK_EXCERPT_MAX)
    expect(cut).toMatch(/Wort…$/)
  })

  it('cuts a text without spaces at the bound', () => {
    const cut = markExcerpt('x'.repeat(300))
    expect(cut).toHaveLength(MARK_EXCERPT_MAX)
    expect(cut.endsWith('…')).toBe(true)
  })
})

describe('mergeNewestFirst', () => {
  it('orders by instant, then id, and says truncated for a cut or a truncated source', () => {
    const row = (id: string, minutes: number) => ({ id, at: minutesAgo(minutes).toISOString() })
    expect(mergeNewestFirst([{ items: [row('a', 2), row('c', 1)], truncated: false }, { items: [row('b', 1)], truncated: false }], 5)).toEqual({
      items: [row('c', 1), row('b', 1), row('a', 2)],
      truncated: false,
    })
    expect(mergeNewestFirst([{ items: [row('a', 2), row('b', 1)], truncated: false }], 1).truncated).toBe(true)
    expect(mergeNewestFirst([{ items: [], truncated: true }], 1).truncated).toBe(true)
  })
})
