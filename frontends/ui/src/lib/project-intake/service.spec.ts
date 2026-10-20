/**
 * @vitest-environment node
 */
/**
 * The project intake service (ADR-0111), with every seam it reaches through
 * mocked: the intake repository, the profile's one door
 * (`patchProjectProfile`), the readable files, the masking policy, the
 * submission, the inbox and the score. `computeNeeds` and the building class
 * rule are mocked too: what is under test is what the service does with their
 * answers, not the answers.
 *
 * Pinned here: what a recorded value becomes (each refusal, a new suggestion
 * with its quote masked, a corroboration, a contradiction on a confirmed fact,
 * the derived class and never over a confirmed one); a stale job is refused; a
 * lost optimistic lock is planned again, three times at most; what each
 * decision writes and which are scored; a reading starts single-flight and a
 * failed submission fails it; finishing records what was read by content and
 * starts a queued rerun; finishing the review closes a past project.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('server-only', () => ({}))
vi.mock('@/lib/authz/projects', () => ({ requireProjectAccess: vi.fn() }))
vi.mock('@/lib/db/tenant-context', async (original) => ({
  ...(await original<typeof import('@/lib/db/tenant-context')>()),
  withTenant: (_scope: unknown, run: () => unknown) => run(),
}))
vi.mock('./repository', () => ({
  addIntakeDismissed: vi.fn(),
  claimIntakeReading: vi.fn(),
  completeProjectIntake: vi.fn(),
  endIntakeReading: vi.fn(),
  findProjectIntake: vi.fn(),
  findProjectIntakeByJobId: vi.fn(),
  requestIntakeRerun: vi.fn(),
}))
vi.mock('@/lib/projects/repository', () => ({ findProjectInOrg: vi.fn(), findProjectProfileInOrg: vi.fn() }))
vi.mock('@/lib/projects/service', () => ({ setProjectStatus: vi.fn() }))
vi.mock('@/lib/project-profile/profile-service', () => ({ patchProjectProfile: vi.fn() }))
vi.mock('@/lib/project-experience/readable-files', () => ({ extractableDocuments: vi.fn() }))
vi.mock('@/lib/upload-screening/service', () => ({
  maskChatText: vi.fn(async (_org: string, text: string) => ({ text: text.replaceAll('Max Mustermann', '[Name]') })),
  maskAnswerText: vi.fn(async (_org: string, text: string) => ({ text: text.replaceAll('Max Mustermann', '[Name]') })),
}))
vi.mock('@/lib/jobs/backend-client', async (original) => ({
  ...(await original<typeof import('@/lib/jobs/backend-client')>()),
  fetchBackendJobOutcome: vi.fn(),
}))
vi.mock('@/lib/langfuse/decision-score', () => ({ recordDecisionScore: vi.fn(async () => undefined) }))
vi.mock('./attention', () => ({
  onIntakeReady: vi.fn(async () => undefined),
  onIntakeCompleted: vi.fn(async () => undefined),
}))
vi.mock('./run', () => ({ mintIntakeJobId: vi.fn(() => 'intake-job-2'), submitIntakeRun: vi.fn() }))
vi.mock('./trigger', () => ({ enqueueIntakeRead: vi.fn(async () => true) }))
vi.mock('./needs', async (importOriginal) => ({ ...(await importOriginal<typeof import('./needs')>()), computeNeeds: vi.fn() }))
vi.mock('./derivations', async (original) => ({
  ...(await original<typeof import('./derivations')>()),
  deriveBuildingClass: vi.fn(),
}))

import { ConflictError, ForbiddenError, NotFoundError } from '@/lib/api/errors'
import type { AuthorizedSession } from '@/lib/auth/types'
import { requireProjectAccess } from '@/lib/authz/projects'
import type { Project } from '@/lib/db/schema'
import type { ProjectIntakeRow } from '@/lib/db/schema/project-intakes'
import { fetchBackendJobOutcome } from '@/lib/jobs/backend-client'
import { recordDecisionScore } from '@/lib/langfuse/decision-score'
import { extractableDocuments, type ExtractableDocument } from '@/lib/project-experience/readable-files'
import { patchProjectProfile, type PatchedProjectProfile } from '@/lib/project-profile/profile-service'
import type { ProjectProfile, ProjectProfilePatchOperation } from '@/lib/project-profile/types'
import { projectClosedError } from '@/lib/projects/project-status'
import { findProjectInOrg, findProjectProfileInOrg, type ProjectProfileState } from '@/lib/projects/repository'
import { setProjectStatus } from '@/lib/projects/service'
import { onIntakeCompleted, onIntakeReady } from './attention'
import { deriveBuildingClass } from './derivations'
import { computeNeeds } from './needs'
import {
  addIntakeDismissed,
  claimIntakeReading,
  completeProjectIntake,
  endIntakeReading,
  findProjectIntake,
  findProjectIntakeByJobId,
  requestIntakeRerun,
} from './repository'
import { submitIntakeRun } from './run'
import {
  applyIntakeDecisions,
  completeIntake,
  finishIntakeReading,
  getIntakeView,
  intakeNeeds,
  MAX_WRITE_ATTEMPTS,
  recordIntakeValues,
  runIntakeReadSlice,
  settleIntakeOutcome,
  startIntakeRun,
  withdrawIntakeValues,
} from './service'
import { enqueueIntakeRead } from './trigger'
import type { Need, RecordValue } from './types'

const ORG = 'org_1'
const PROJECT = '6f1c2d3e-4a5b-4c6d-8e7f-9a0b1c2d3e4f'
const JOB = 'intake-job-1'
const NOW = '2026-10-14T09:00:00.000Z'
const DOC_A = '0b7c8f5e-1d1e-4c39-9d2c-3f0f6c1a2b3c'
const DOC_B = '1b7c8f5e-1d1e-4c39-9d2c-3f0f6c1a2b3c'

const SESSION = {
  userId: 'user_1',
  organizationId: ORG,
  organizationMembershipId: 'om_1',
  email: 'anna@grid.test',
  name: 'Anna Berger',
  role: 'member',
  permissions: [],
} as Partial<AuthorizedSession> as AuthorizedSession

const intake = (overrides: Partial<ProjectIntakeRow> = {}): ProjectIntakeRow => ({
  id: 'intake-1',
  organizationId: ORG,
  projectId: PROJECT,
  createdBy: 'user_1',
  mode: 'active',
  description: 'Wohnhausanlage, Zubau',
  location: null,
  closing: null,
  status: 'reading',
  jobId: JOB,
  requestedBy: 'user_2',
  traceId: null,
  rerunRequested: false,
  documentsRead: [],
  dismissed: [],
  counts: null,
  summary: null,
  startedAt: new Date(NOW),
  finishedAt: null,
  completedAt: null,
  completedBy: null,
  createdAt: new Date(NOW),
  updatedAt: new Date(NOW),
  ...overrides,
})

const need = (key: string, extra: Partial<Need> = {}): Need => ({
  key,
  baseKey: key.split('@')[0],
  bauwerkId: /@(bw\d+)/.exec(key)?.[1] ?? null,
  label: key,
  type: 'text',
  foundIn: [],
  decisive: false,
  state: 'open',
  ...extra,
})

const emptyProfile = (): ProjectProfile => ({ facts: {}, goals: {}, unknowns: [], assumptions: {} })

const document = (overrides: Partial<ExtractableDocument> = {}): ExtractableDocument => ({
  documentId: DOC_A,
  fileName: 'Einreichplan.pdf',
  contentHash: 'sha256:aaa',
  updatedAt: new Date(NOW),
  ...overrides,
})

const value = (key: string, recorded: RecordValue['value'], extra: Partial<RecordValue['evidence']> = {}): RecordValue => ({
  key,
  value: recorded,
  evidence: { fileName: 'Einreichplan.pdf', page: 2, quote: 'Bauwerber: Max Mustermann, Gebäude', ...extra },
})

let profile: ProjectProfile

function useProfile(next: ProjectProfile) {
  profile = next
  vi.mocked(findProjectProfileInOrg).mockImplementation(
    async () => ({ profile, profileVersion: 1 }) as Partial<ProjectProfileState> as ProjectProfileState
  )
}

/** The operations of the n-th profile write. */
const written = (call = 0): ProjectProfilePatchOperation[] => vi.mocked(patchProjectProfile).mock.calls[call][2]
const op = (path: string, call = 0) => written(call).find((operation) => operation.path === path)

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(requireProjectAccess).mockResolvedValue({ role: 'project-editor', closed: false, readsBecauseClosed: false })
  vi.mocked(findProjectIntake).mockResolvedValue(intake())
  vi.mocked(findProjectInOrg).mockResolvedValue({
    id: PROJECT,
    name: 'Wohnbau Seestraße',
    collectionName: 'proj_main',
  } as Partial<Project> as Project)
  vi.mocked(extractableDocuments).mockResolvedValue([document(), document({ documentId: DOC_B, fileName: 'Baubeschreibung.pdf', contentHash: null })])
  vi.mocked(computeNeeds).mockReturnValue([
    need('bauwerkstyp@bw1', { type: 'single_select', options: [{ token: 'gebaeude', label: 'Gebäude' }, { token: 'klein', label: 'Klein' }] }),
    need('gebaeudestellung@bw1', { type: 'single_select' }),
    need('geschosse_oberirdisch@bw1', { type: 'number_tri', decisive: true }),
  ])
  vi.mocked(deriveBuildingClass).mockImplementation((inputs) =>
    inputs.geschosse_oberirdisch === undefined
      ? { value: null, hochhaus: false, applicable: true, missing: ['geschosse_oberirdisch'] }
      : { value: 3, hochhaus: false, applicable: true, missing: [] }
  )
  vi.mocked(patchProjectProfile).mockResolvedValue({} as Partial<PatchedProjectProfile> as PatchedProjectProfile)
  useProfile(emptyProfile())
})

// ---------------------------------------------------------------------------

describe('recordIntakeValues — what a value becomes', () => {
  it('refuses a job that is not the current reading, 409 stale-reading, before reading anything else', async () => {
    vi.mocked(findProjectIntake).mockResolvedValue(intake({ jobId: 'intake-job-0' }))
    const refused = recordIntakeValues(SESSION, PROJECT, JOB, [value('bauwerkstyp@bw1', 'gebaeude')])
    await expect(refused).rejects.toBeInstanceOf(ConflictError)
    await expect(refused).rejects.toMatchObject({ details: { reason: 'stale-reading' } })

    vi.mocked(findProjectIntake).mockResolvedValue(intake({ status: 'ready' }))
    await expect(recordIntakeValues(SESSION, PROJECT, JOB, [value('bauwerkstyp@bw1', 'gebaeude')])).rejects.toMatchObject({
      details: { reason: 'stale-reading' },
    })
    expect(patchProjectProfile).not.toHaveBeenCalled()
  })

  it('refuses outside the vocabulary, a dismissed value, a file outside the main collection and a key no question writes', async () => {
    vi.mocked(findProjectIntake).mockResolvedValue(intake({ dismissed: [{ key: 'gebaeudestellung@bw1', value: 'angebaut' }] }))

    const { results } = await recordIntakeValues(SESSION, PROJECT, JOB, [
      value('bauwerkstyp@bw1', 'hochhaus'),
      value('gebaeudestellung@bw1', 'angebaut'),
      value('bauwerkstyp@bw1', 'gebaeude', { fileName: 'Vertraulich/Honorar.pdf' }),
      value('nicht_im_assistenten', 'x'),
      value('bauwerkstyp@bw1', ''),
      value('bauwerkstyp@bw1', 'noch_offen'),
    ])

    expect(results).toEqual([
      { key: 'bauwerkstyp@bw1', outcome: 'refused', reason: 'vocabulary' },
      { key: 'gebaeudestellung@bw1', outcome: 'refused', reason: 'dismissed' },
      { key: 'bauwerkstyp@bw1', outcome: 'refused', reason: 'unreadable-file' },
      { key: 'nicht_im_assistenten', outcome: 'refused', reason: 'unknown-key' },
      { key: 'bauwerkstyp@bw1', outcome: 'refused', reason: 'vocabulary' },
      { key: 'bauwerkstyp@bw1', outcome: 'refused', reason: 'vocabulary' },
    ])
    expect(patchProjectProfile).not.toHaveBeenCalled()
  })

  it('refuses a key in a scope its question is not asked in, or on a building the profile does not describe', async () => {
    const { results } = await recordIntakeValues(SESSION, PROJECT, JOB, [
      value('bundesland@bw1', 'wien'),
      value('geschosse_oberirdisch', 3),
      value('geschosse_oberirdisch@bw2', 3),
      value('wohneinheiten@bw1@buero', 4),
      value('gebaeudeklasse@bw1', 3),
    ])

    expect(results.map((result) => result.reason)).toEqual(['unknown-key', 'unknown-key', 'unknown-key', 'unknown-key', 'unknown-key'])
    expect(patchProjectProfile).not.toHaveBeenCalled()
  })

  it('takes a value whose question is not asked yet: the Wohnungen before the Nutzungen that open them, in any order', async () => {
    // computeNeeds (mocked) lists neither: no answer opens their questions yet.
    const { results } = await recordIntakeValues(SESSION, PROJECT, JOB, [
      value('wohneinheiten@bw1@wohnen', 12),
      value('nutzungen@bw1', ['wohnen']),
      value('fluchtniveau_m@bw1', 7.2),
    ])

    expect(results).toEqual([
      { key: 'wohneinheiten@bw1@wohnen', outcome: 'suggested' },
      { key: 'nutzungen@bw1', outcome: 'suggested' },
      { key: 'fluchtniveau_m@bw1', outcome: 'suggested' },
    ])
    expect(op('/assumptions/wohneinheiten@bw1@wohnen')?.value).toMatchObject({ value: 12, source: 'agent_suggested' })
  })

  it('records on every building the profile describes, and adds none', async () => {
    const fact = { value: 'gebaeude', confidence: 'confirmed', source: 'onboarding', updatedAt: NOW } as const
    useProfile({ ...emptyProfile(), facts: { 'bauwerkstyp@bw1': fact, 'bauwerkstyp@bw2': fact } })

    const { results } = await recordIntakeValues(SESSION, PROJECT, JOB, [value('geschosse_oberirdisch@bw2', 3), value('geschosse_oberirdisch@bw3', 2)])

    expect(results).toEqual([
      { key: 'geschosse_oberirdisch@bw2', outcome: 'suggested' },
      { key: 'geschosse_oberirdisch@bw3', outcome: 'refused', reason: 'unknown-key' },
    ])
  })

  it('writes a new value as a suggestion with its evidence, the quote masked before it is stored', async () => {
    const { results } = await recordIntakeValues(SESSION, PROJECT, JOB, [value('bauwerkstyp@bw1', 'gebaeude')])

    expect(results).toEqual([{ key: 'bauwerkstyp@bw1', outcome: 'suggested' }])
    expect(patchProjectProfile).toHaveBeenCalledTimes(1)
    expect(vi.mocked(patchProjectProfile).mock.calls[0][0]).toBe(SESSION)
    const suggestion = op('/assumptions/bauwerkstyp@bw1')?.value
    expect(suggestion).toMatchObject({
      value: 'gebaeude',
      status: 'unconfirmed',
      source: 'agent_suggested',
      reason: 'Einreichplan.pdf, S. 2: „Bauwerber: [Name], Gebäude"',
      evidence: [{ kind: 'document', fileName: 'Einreichplan.pdf', page: 2, quote: 'Bauwerber: [Name], Gebäude' }],
    })
    expect(JSON.stringify(written())).not.toContain('Mustermann')
  })

  it('corroborates a confirmed fact with the same value: its evidence grows, the fact stays', async () => {
    useProfile({
      ...emptyProfile(),
      facts: { 'gebaeudestellung@bw1': { value: 'freistehend', confidence: 'confirmed', source: 'onboarding', updatedAt: NOW } },
    })

    const { results } = await recordIntakeValues(SESSION, PROJECT, JOB, [value('gebaeudestellung@bw1', 'freistehend')])

    expect(results).toEqual([{ key: 'gebaeudestellung@bw1', outcome: 'corroborated' }])
    expect(op('/facts/gebaeudestellung@bw1')?.value).toMatchObject({
      value: 'freistehend',
      confidence: 'confirmed',
      evidence: [{ kind: 'document', fileName: 'Einreichplan.pdf' }],
    })
  })

  it('records a different value beside a confirmed fact as an alternative ON THE FACT, never over it, even when the key is no longer a need', async () => {
    useProfile({
      ...emptyProfile(),
      facts: { 'fluchtniveau_m@bw1': { value: 6.5, confidence: 'confirmed', source: 'user_confirmed', updatedAt: NOW } },
    })

    const { results } = await recordIntakeValues(SESSION, PROJECT, JOB, [value('fluchtniveau_m@bw1', 7.2)])

    expect(results).toEqual([{ key: 'fluchtniveau_m@bw1', outcome: 'contradiction' }])
    const fact = op('/facts/fluchtniveau_m@bw1')?.value as { value: number; alternatives: Array<{ value: number }> }
    expect(fact.value).toBe(6.5)
    expect(fact.alternatives).toEqual([
      expect.objectContaining({ value: 7.2, evidence: [expect.objectContaining({ kind: 'document' })] }),
    ])
    expect(op('/assumptions/fluchtniveau_m@bw1')).toBeUndefined()
  })

  it('records a different value beside an earlier suggestion as an alternative on the suggestion', async () => {
    useProfile({
      ...emptyProfile(),
      assumptions: {
        'bauwerkstyp@bw1': { value: 'klein', status: 'unconfirmed', reason: 'x', source: 'agent_suggested', updatedAt: NOW },
      },
    })

    const { results } = await recordIntakeValues(SESSION, PROJECT, JOB, [value('bauwerkstyp@bw1', 'gebaeude')])

    expect(results).toEqual([{ key: 'bauwerkstyp@bw1', outcome: 'contradiction' }])
    expect(op('/assumptions/bauwerkstyp@bw1')?.value).toMatchObject({
      value: 'klein',
      alternatives: [{ value: 'gebaeude' }],
    })
  })

  it('derives the building class when an input moved, as a suggestion with its derivation and inputs', async () => {
    useProfile({
      ...emptyProfile(),
      facts: { 'bauwerkstyp@bw1': { value: 'gebaeude', confidence: 'confirmed', source: 'onboarding', updatedAt: NOW } },
    })

    await recordIntakeValues(SESSION, PROJECT, JOB, [value('geschosse_oberirdisch@bw1', 3)])

    const derived = op('/assumptions/gebaeudeklasse@bw1')?.value as Record<string, unknown>
    expect(derived).toMatchObject({ value: 3, source: 'agent_suggested', status: 'unconfirmed' })
    expect(derived.evidence).toEqual([
      expect.objectContaining({
        kind: 'derivation',
        rule: 'gebaeudeklasse',
        inputs: expect.arrayContaining([
          { key: 'bauwerkstyp@bw1', value: 'gebaeude', suggested: false },
          { key: 'geschosse_oberirdisch@bw1', value: 3, suggested: true },
        ]),
      }),
    ])
  })

  it('refuses the building class a document states, beside a confirmed class too: it is derived, never recorded', async () => {
    useProfile({
      ...emptyProfile(),
      facts: { 'gebaeudeklasse@bw1': { value: 4, confidence: 'confirmed', source: 'user_confirmed', updatedAt: NOW } },
    })

    const { results } = await recordIntakeValues(SESSION, PROJECT, JOB, [value('gebaeudeklasse@bw1', 1), value('gebaeudeklasse@bw2', 1)])

    expect(results).toEqual([
      { key: 'gebaeudeklasse@bw1', outcome: 'refused', reason: 'unknown-key' },
      { key: 'gebaeudeklasse@bw2', outcome: 'refused', reason: 'unknown-key' },
    ])
    expect(patchProjectProfile).not.toHaveBeenCalled()
  })

  it('never derives over a confirmed building class: a different class becomes an alternative on the fact', async () => {
    useProfile({
      ...emptyProfile(),
      facts: { 'gebaeudeklasse@bw1': { value: 2, confidence: 'confirmed', source: 'user_confirmed', updatedAt: NOW } },
    })

    await recordIntakeValues(SESSION, PROJECT, JOB, [value('geschosse_oberirdisch@bw1', 3)])

    expect(op('/assumptions/gebaeudeklasse@bw1')).toBeUndefined()
    expect(op('/facts/gebaeudeklasse@bw1')?.value).toMatchObject({
      value: 2,
      alternatives: [{ value: 3, evidence: [expect.objectContaining({ kind: 'derivation' })] }],
    })
  })

  it('marks a suggestion with the reading that made it', async () => {
    await recordIntakeValues(SESSION, PROJECT, JOB, [value('bauwerkstyp@bw1', 'gebaeude')])
    expect(op('/assumptions/bauwerkstyp@bw1')?.value).toMatchObject({ readingId: JOB })
  })

  it('names the needs the values opened, decisive first, from the needs before and after the same write', async () => {
    vi.mocked(computeNeeds).mockImplementation((current) =>
      current.assumptions['bauwerkstyp@bw1']
        ? [
            need('geschosse_oberirdisch@bw1', { decisive: true }),
            need('bauwerkstyp@bw1', { state: 'suggested' }),
            need('gebaeudestellung@bw1'),
          ]
        : [need('bauwerkstyp@bw1', { decisive: true })]
    )

    const { opened } = await recordIntakeValues(SESSION, PROJECT, JOB, [value('bauwerkstyp@bw1', 'gebaeude')])

    expect(opened).toEqual([
      { key: 'geschosse_oberirdisch@bw1', decisive: true },
      { key: 'gebaeudestellung@bw1', decisive: false },
    ])
    expect(computeNeeds).toHaveBeenCalledWith(expect.anything(), expect.anything(), { mode: 'active', dismissed: [] })
  })

  it('plans again on the fresh profile after a lost optimistic lock', async () => {
    vi.mocked(patchProjectProfile)
      .mockRejectedValueOnce(new ConflictError('Conflict: profile was modified by another request'))
      .mockResolvedValueOnce({} as Partial<PatchedProjectProfile> as PatchedProjectProfile)

    const { results } = await recordIntakeValues(SESSION, PROJECT, JOB, [value('bauwerkstyp@bw1', 'gebaeude')])

    expect(results).toEqual([{ key: 'bauwerkstyp@bw1', outcome: 'suggested' }])
    expect(patchProjectProfile).toHaveBeenCalledTimes(2)
    // The profile was read again for the second plan (once per attempt; the screen does not read it).
    expect(findProjectProfileInOrg).toHaveBeenCalledTimes(2)
  })

  it(`gives up after ${MAX_WRITE_ATTEMPTS} lost locks and says so`, async () => {
    vi.mocked(patchProjectProfile).mockRejectedValue(new ConflictError('Conflict'))

    await expect(recordIntakeValues(SESSION, PROJECT, JOB, [value('bauwerkstyp@bw1', 'gebaeude')])).rejects.toBeInstanceOf(
      ConflictError
    )
    expect(patchProjectProfile).toHaveBeenCalledTimes(MAX_WRITE_ATTEMPTS)
  })
})

// ---------------------------------------------------------------------------

describe('withdrawIntakeValues — a reading takes back its own suggestion', () => {
  const suggested = (readingId?: string) => ({
    value: 'einreichplanung',
    status: 'unconfirmed' as const,
    reason: 'x',
    source: 'agent_suggested' as const,
    updatedAt: NOW,
    ...(readingId ? { readingId } : {}),
  })

  it('removes this reading’s suggestion with what was found beside it, and remembers nothing as dismissed', async () => {
    useProfile({
      ...emptyProfile(),
      assumptions: { projektphase: { ...suggested(JOB), alternatives: [{ value: 'entwurf', evidence: [], recordedAt: NOW }] } },
    })

    const { results } = await withdrawIntakeValues(SESSION, PROJECT, JOB, ['projektphase'])

    expect(results).toEqual([{ key: 'projektphase', outcome: 'withdrawn' }])
    expect(written()).toEqual([{ op: 'remove', path: '/assumptions/projektphase' }])
    expect(addIntakeDismissed).not.toHaveBeenCalled()
  })

  it('refuses a confirmed value, another reading’s suggestion, the derived class and a key with nothing suggested', async () => {
    useProfile({
      ...emptyProfile(),
      facts: { 'bauwerkstyp@bw1': { value: 'gebaeude', confidence: 'confirmed', source: 'user_confirmed', updatedAt: NOW } },
      assumptions: {
        projektphase: suggested('intake-job-0'),
        'gebaeudeklasse@bw1': { ...suggested(), value: 3 },
        bundesland: { ...suggested(JOB), value: 'wien', source: 'onboarding_default' },
      },
    })

    const { results } = await withdrawIntakeValues(SESSION, PROJECT, JOB, [
      'bauwerkstyp@bw1',
      'projektphase',
      'gebaeudeklasse@bw1',
      'bundesland',
      'waermeversorgung@bw1',
    ])

    expect(results).toEqual([
      { key: 'bauwerkstyp@bw1', outcome: 'refused', reason: 'confirmed' },
      { key: 'projektphase', outcome: 'refused', reason: 'not-this-reading' },
      { key: 'gebaeudeklasse@bw1', outcome: 'refused', reason: 'not-this-reading' },
      { key: 'bundesland', outcome: 'refused', reason: 'not-this-reading' },
      { key: 'waermeversorgung@bw1', outcome: 'refused', reason: 'nothing-suggested' },
    ])
    expect(patchProjectProfile).not.toHaveBeenCalled()
  })

  it('takes the derived class with a withdrawn input it was derived from', async () => {
    useProfile({
      ...emptyProfile(),
      facts: { 'bauwerkstyp@bw1': { value: 'gebaeude', confidence: 'confirmed', source: 'onboarding', updatedAt: NOW } },
      assumptions: {
        'geschosse_oberirdisch@bw1': { ...suggested(JOB), value: 3 },
        'gebaeudeklasse@bw1': {
          ...suggested(),
          value: 3,
          evidence: [{ kind: 'derivation', rule: 'gebaeudeklasse', citation: 'OIB', inputs: [] }],
        },
      },
    })

    await withdrawIntakeValues(SESSION, PROJECT, JOB, ['geschosse_oberirdisch@bw1'])

    expect(op('/assumptions/geschosse_oberirdisch@bw1')).toEqual({ op: 'remove', path: '/assumptions/geschosse_oberirdisch@bw1' })
    expect(op('/assumptions/gebaeudeklasse@bw1')).toEqual({ op: 'remove', path: '/assumptions/gebaeudeklasse@bw1' })
  })

  it('leaves a withdrawn value free for a later reading, where a dismissed one stays refused', async () => {
    useProfile({ ...emptyProfile(), assumptions: { 'bauwerkstyp@bw1': { ...suggested(JOB), value: 'gebaeude' } } })
    await withdrawIntakeValues(SESSION, PROJECT, JOB, ['bauwerkstyp@bw1'])
    expect(addIntakeDismissed).not.toHaveBeenCalled()

    // The next reading, on the profile the withdrawal left; a person dismissed another value meanwhile.
    useProfile(emptyProfile())
    vi.mocked(findProjectIntake).mockResolvedValue(
      intake({ jobId: 'intake-job-2', dismissed: [{ key: 'gebaeudestellung@bw1', value: 'angebaut' }] })
    )
    const { results } = await recordIntakeValues(SESSION, PROJECT, 'intake-job-2', [
      value('bauwerkstyp@bw1', 'gebaeude'),
      value('gebaeudestellung@bw1', 'angebaut'),
    ])

    expect(results).toEqual([
      { key: 'bauwerkstyp@bw1', outcome: 'suggested' },
      { key: 'gebaeudestellung@bw1', outcome: 'refused', reason: 'dismissed' },
    ])
  })

  it('refuses a job that is not the current reading', async () => {
    vi.mocked(findProjectIntake).mockResolvedValue(intake({ jobId: 'intake-job-9' }))
    await expect(withdrawIntakeValues(SESSION, PROJECT, JOB, ['projektphase'])).rejects.toMatchObject({
      details: { reason: 'stale-reading' },
    })
    expect(patchProjectProfile).not.toHaveBeenCalled()
  })
})

describe('intakeNeeds', () => {
  it('answers the needs and the readable files not read in the bytes they hold now', async () => {
    vi.mocked(findProjectIntake).mockResolvedValue(
      intake({ documentsRead: [{ documentId: DOC_A, contentHash: 'sha256:aaa' }], location: null })
    )

    const answer = await intakeNeeds(SESSION, PROJECT, JOB)

    expect(answer.unreadFiles).toEqual(['Baubeschreibung.pdf'])
    expect(answer.needs.map((entry) => entry.key)).toContain('bauwerkstyp@bw1')
    expect(answer).toMatchObject({ description: 'Wohnhausanlage, Zubau', location: null, mode: 'active', previousSummary: null })
  })

  it('hands the last reading its own summary back, as stored', async () => {
    vi.mocked(findProjectIntake).mockResolvedValue(intake({ summary: 'Einreichplan gelesen; Fluchtniveau offen.' }))
    expect((await intakeNeeds(SESSION, PROJECT, JOB)).previousSummary).toBe('Einreichplan gelesen; Fluchtniveau offen.')
  })

  it('reads a document again when its bytes changed (a new Fassung)', async () => {
    vi.mocked(findProjectIntake).mockResolvedValue(
      intake({ documentsRead: [{ documentId: DOC_A, contentHash: 'sha256:old' }] })
    )
    expect((await intakeNeeds(SESSION, PROJECT, JOB)).unreadFiles).toEqual(['Einreichplan.pdf', 'Baubeschreibung.pdf'])
  })
})

// ---------------------------------------------------------------------------

describe('finishIntakeReading', () => {
  it('ends the reading ready with what it read by content, its counts, its masked summary and its trace, and tells the requester', async () => {
    vi.mocked(endIntakeReading).mockImplementation(async (_org, _project, _job, end) =>
      intake({ status: 'ready', documentsRead: end.documentsRead ?? [] })
    )

    const answer = await finishIntakeReading(SESSION, PROJECT, JOB, {
      summary: '  Zwei Pläne gelesen, Bauwerber Max Mustermann.  ',
      documentsRead: ['Einreichplan.pdf', 'Baubeschreibung.pdf', 'Unbekannt.pdf'],
      traceId: 'trace-1',
    })

    expect(answer).toEqual({ status: 'ready' })
    const end = vi.mocked(endIntakeReading).mock.calls[0][3]
    expect(end).toMatchObject({
      status: 'ready',
      summary: 'Zwei Pläne gelesen, Bauwerber [Name].',
      traceId: 'trace-1',
      counts: { documentsRead: 2, decisiveOpen: 1 },
    })
    expect(end.documentsRead).toEqual([
      { documentId: DOC_A, contentHash: 'sha256:aaa' },
      { documentId: DOC_B, contentHash: `updated:${NOW}` },
    ])
    expect(onIntakeReady).toHaveBeenCalledWith(
      expect.objectContaining({ recipientUserId: 'user_2', projectName: 'Wohnbau Seestraße', decisiveOpen: 1 })
    )
  })

  it('is stale when the reading ended meanwhile', async () => {
    vi.mocked(endIntakeReading).mockResolvedValue(null)
    await expect(
      finishIntakeReading(SESSION, PROJECT, JOB, { summary: '', documentsRead: [], traceId: null })
    ).rejects.toMatchObject({ details: { reason: 'stale-reading' } })
    expect(onIntakeReady).not.toHaveBeenCalled()
  })

  it('starts the rerun a trigger asked for meanwhile, as the same person', async () => {
    vi.mocked(endIntakeReading).mockResolvedValue(intake({ status: 'ready', rerunRequested: true }))
    vi.mocked(claimIntakeReading).mockResolvedValue(intake({ jobId: 'intake-job-2' }))
    vi.mocked(submitIntakeRun).mockResolvedValue('intake-job-2')

    const answer = await finishIntakeReading(SESSION, PROJECT, JOB, { summary: 'ok', documentsRead: [], traceId: null })

    expect(answer).toEqual({ status: 'reading' })
    expect(submitIntakeRun).toHaveBeenCalledWith(
      expect.objectContaining({ jobId: 'intake-job-2', userId: 'user_1', scope: 'new', trigger: 'upload' })
    )
  })
})

// ---------------------------------------------------------------------------

describe('startIntakeRun', () => {
  it('claims the reading under a minted job id first, then submits it as the reader', async () => {
    vi.mocked(findProjectIntake).mockResolvedValue(intake({ status: 'waiting', jobId: null }))
    vi.mocked(claimIntakeReading).mockResolvedValue(intake({ jobId: 'intake-job-2' }))
    vi.mocked(submitIntakeRun).mockResolvedValue('intake-job-2')

    const view = await startIntakeRun(SESSION, PROJECT, { scope: 'all' })

    expect(vi.mocked(claimIntakeReading).mock.calls[0][2]).toMatchObject({
      jobId: 'intake-job-2',
      requestedBy: 'user_1',
      forgetRead: true,
    })
    expect(submitIntakeRun).toHaveBeenCalledWith(
      expect.objectContaining({ collectionName: 'proj_main', jobId: 'intake-job-2', scope: 'all', trigger: 'click' })
    )
    expect(view.status).toBe('reading')
    expect(requireProjectAccess).toHaveBeenCalledWith(SESSION, PROJECT, ['project:memory:write', 'project:edit'])
  })

  it('records a rerun instead of a second reading while one runs', async () => {
    vi.mocked(requestIntakeRerun).mockResolvedValue(intake({ rerunRequested: true }))

    await startIntakeRun(SESSION, PROJECT, { scope: 'new' })

    expect(requestIntakeRerun).toHaveBeenCalledWith(ORG, PROJECT)
    expect(claimIntakeReading).not.toHaveBeenCalled()
    expect(submitIntakeRun).not.toHaveBeenCalled()
  })

  it('refuses a closed project with a 409 the review can name', async () => {
    vi.mocked(requireProjectAccess).mockRejectedValue(projectClosedError())
    await expect(startIntakeRun(SESSION, PROJECT, { scope: 'new' })).rejects.toMatchObject({
      status: 409,
      details: { reason: 'project-closed' },
    })
  })

  it('fails the reading when the backend refuses the submission, and says so', async () => {
    vi.mocked(findProjectIntake).mockResolvedValue(intake({ status: 'failed' }))
    vi.mocked(claimIntakeReading).mockResolvedValue(intake({ jobId: 'intake-job-2' }))
    vi.mocked(submitIntakeRun).mockRejectedValue(new Error('backend down'))
    vi.spyOn(console, 'error').mockImplementation(() => undefined)

    await expect(startIntakeRun(SESSION, PROJECT, { scope: 'new' })).rejects.toMatchObject({
      status: 503,
      details: { reason: 'submit-failed' },
    })
    expect(endIntakeReading).toHaveBeenCalledWith(ORG, PROJECT, 'intake-job-2', expect.objectContaining({ status: 'failed' }))
  })

  it('refuses a finished review', async () => {
    vi.mocked(findProjectIntake).mockResolvedValue(intake({ status: 'completed', completedAt: new Date(), completedBy: 'u' }))
    await expect(startIntakeRun(SESSION, PROJECT, { scope: 'new' })).rejects.toMatchObject({
      details: { reason: 'intake-completed' },
    })
  })
})

describe('runIntakeReadSlice — the upload trigger as a BFF job', () => {
  it('starts a reading of what is new, at bulk priority', async () => {
    vi.mocked(findProjectIntake).mockResolvedValue(intake({ status: 'ready' }))
    vi.mocked(claimIntakeReading).mockResolvedValue(intake({ jobId: 'intake-job-2' }))
    vi.mocked(submitIntakeRun).mockResolvedValue('intake-job-2')

    const payload = { projectId: PROJECT }
    expect(await runIntakeReadSlice(SESSION, payload)).toEqual({ done: true, payload })
    expect(submitIntakeRun).toHaveBeenCalledWith(expect.objectContaining({ scope: 'new', trigger: 'upload' }))
  })

  it('ends quietly for an uploader who may not write the profile', async () => {
    vi.mocked(requireProjectAccess).mockRejectedValue(new NotFoundError())
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)

    expect(await runIntakeReadSlice(SESSION, { projectId: PROJECT })).toMatchObject({ done: true })
    expect(submitIntakeRun).not.toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------

describe('applyIntakeDecisions', () => {
  const suggested = (value: string | number, extra = {}) => ({
    value,
    status: 'unconfirmed' as const,
    reason: 'Einreichplan.pdf, S. 2: „…"',
    source: 'agent_suggested' as const,
    updatedAt: NOW,
    evidence: [{ kind: 'document' as const, fileName: 'Einreichplan.pdf', page: 2, quote: '3 Geschoße' }],
    ...extra,
  })

  beforeEach(() => {
    vi.mocked(findProjectIntake).mockResolvedValue(intake({ status: 'ready', traceId: 'trace-1' }))
    vi.mocked(addIntakeDismissed).mockResolvedValue(intake({ status: 'ready' }))
  })

  it('confirms a suggestion as a fact with its evidence, and scores it accepted on the reading’s trace', async () => {
    useProfile({ ...emptyProfile(), assumptions: { 'geschosse_oberirdisch@bw1': suggested(3) } })

    const { results, intake: view } = await applyIntakeDecisions(SESSION, PROJECT, [
      { key: 'geschosse_oberirdisch@bw1', action: 'confirm' },
    ])

    expect(results).toEqual([{ key: 'geschosse_oberirdisch@bw1', ok: true }])
    expect(op('/facts/geschosse_oberirdisch@bw1')?.value).toMatchObject({
      value: 3,
      confidence: 'confirmed',
      source: 'user_confirmed',
      evidence: [{ kind: 'document', fileName: 'Einreichplan.pdf' }],
    })
    expect(recordDecisionScore).toHaveBeenCalledWith(
      expect.objectContaining({ subject: 'intake_suggestion', decision: 'accepted', traceId: 'trace-1' })
    )
    expect(view.projectId).toBe(PROJECT)
  })

  it('confirms the chosen alternative instead', async () => {
    useProfile({
      ...emptyProfile(),
      assumptions: {
        'geschosse_oberirdisch@bw1': suggested(3, {
          alternatives: [{ value: 4, evidence: [{ kind: 'document', fileName: 'B.pdf', page: 1, quote: '4 G' }], recordedAt: NOW }],
        }),
      },
    })

    await applyIntakeDecisions(SESSION, PROJECT, [{ key: 'geschosse_oberirdisch@bw1', action: 'confirm', alternativeIndex: 0 }])

    expect(op('/facts/geschosse_oberirdisch@bw1')?.value).toMatchObject({ value: 4, evidence: [{ fileName: 'B.pdf' }] })
  })

  it('dismisses a suggestion, remembers the value, and scores it dismissed', async () => {
    useProfile({ ...emptyProfile(), assumptions: { 'bauwerkstyp@bw1': suggested('klein') } })

    await applyIntakeDecisions(SESSION, PROJECT, [{ key: 'bauwerkstyp@bw1', action: 'dismiss' }])

    expect(op('/assumptions/bauwerkstyp@bw1')).toEqual({ op: 'remove', path: '/assumptions/bauwerkstyp@bw1' })
    expect(addIntakeDismissed).toHaveBeenCalledWith(ORG, PROJECT, [{ key: 'bauwerkstyp@bw1', value: 'klein' }])
    expect(recordDecisionScore).toHaveBeenCalledWith(expect.objectContaining({ decision: 'dismissed' }))
  })

  it('writes an answer as a fact with the person as its evidence, and a key marked unknown into the unknowns', async () => {
    await applyIntakeDecisions(SESSION, PROJECT, [
      { key: 'geschosse_oberirdisch@bw1', action: 'answer', value: 4 },
      { key: 'fluchtniveau_m@bw1', action: 'unknown' },
    ])

    expect(op('/facts/geschosse_oberirdisch@bw1')?.value).toMatchObject({
      value: 4,
      source: 'user_confirmed',
      evidence: [{ kind: 'person', userId: 'user_1' }],
    })
    expect(op('/unknowns')).toEqual({ op: 'replace', path: '/unknowns', value: ['fluchtniveau_m@bw1'] })
    expect(recordDecisionScore).not.toHaveBeenCalled()
  })

  it('reports a decision that cannot apply and still applies the others', async () => {
    const { results } = await applyIntakeDecisions(SESSION, PROJECT, [
      { key: 'bauwerkstyp@bw1', action: 'confirm' },
      { key: 'bauwerkstyp@bw1', action: 'answer', value: 'hochhaus' },
      { key: 'bauwerkstyp@bw1', action: 'answer', value: 'gebaeude' },
    ])

    expect(results.map((result) => result.ok)).toEqual([false, false, true])
    expect(results[0].reason).toBe('nothing-to-confirm')
    expect(op('/facts/bauwerkstyp@bw1')?.value).toMatchObject({ value: 'gebaeude' })
  })

  it('needs profile write', async () => {
    vi.mocked(requireProjectAccess).mockRejectedValue(new NotFoundError())
    await expect(applyIntakeDecisions(SESSION, PROJECT, [{ key: 'x', action: 'unknown' }])).rejects.toBeInstanceOf(NotFoundError)
    expect(patchProjectProfile).not.toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------

describe('completeIntake', () => {
  beforeEach(() => {
    vi.mocked(completeProjectIntake).mockResolvedValue(
      intake({ status: 'completed', completedAt: new Date(NOW), completedBy: 'user_1' })
    )
  })

  it('closes a past project with its outcome and Abschluss, then finishes the review and settles the inbox', async () => {
    vi.mocked(findProjectIntake).mockResolvedValue(
      intake({ status: 'ready', mode: 'closing', closing: { outcome: 'completed', endedOn: '2024-06' } })
    )

    const view = await completeIntake(SESSION, PROJECT)

    expect(setProjectStatus).toHaveBeenCalledWith(
      SESSION,
      PROJECT,
      { status: 'closed', outcome: 'completed', endedOn: '2024-06' },
      undefined
    )
    expect(completeProjectIntake).toHaveBeenCalledWith(ORG, PROJECT, 'user_1', expect.any(Date))
    expect(onIntakeCompleted).toHaveBeenCalledWith({ organizationId: ORG, intakeId: 'intake-1' })
    expect(view.status).toBe('completed')
  })

  it('finishes an active project’s review with profile write and closes nothing', async () => {
    vi.mocked(findProjectIntake).mockResolvedValue(intake({ status: 'ready' }))

    await completeIntake(SESSION, PROJECT)

    expect(setProjectStatus).not.toHaveBeenCalled()
    expect(requireProjectAccess).toHaveBeenCalledWith(SESSION, PROJECT, ['project:memory:write', 'project:edit'])
  })

  it('answers a finished review as it is', async () => {
    vi.mocked(findProjectIntake).mockResolvedValue(intake({ status: 'completed', completedAt: new Date(NOW), completedBy: 'u' }))
    await completeIntake(SESSION, PROJECT)
    expect(completeProjectIntake).not.toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------

describe('getIntakeView', () => {
  it('fails a reading the worker never reported back on, once it is older than 30 minutes', async () => {
    vi.mocked(findProjectIntake).mockResolvedValue(intake({ startedAt: new Date(Date.now() - 31 * 60 * 1000) }))
    vi.mocked(fetchBackendJobOutcome).mockResolvedValue(null)
    vi.mocked(endIntakeReading).mockResolvedValue(intake({ status: 'failed' }))

    const view = await getIntakeView(SESSION, PROJECT)

    expect(fetchBackendJobOutcome).toHaveBeenCalledWith(JOB, ORG)
    expect(endIntakeReading).toHaveBeenCalledWith(ORG, PROJECT, JOB, expect.objectContaining({ status: 'failed' }))
    expect(view.status).toBe('failed')
  })

  it('leaves a young reading alone, and a running one', async () => {
    vi.mocked(findProjectIntake).mockResolvedValue(intake({ startedAt: new Date(Date.now() - 5 * 60 * 1000) }))
    await getIntakeView(SESSION, PROJECT)
    expect(fetchBackendJobOutcome).not.toHaveBeenCalled()

    vi.mocked(findProjectIntake).mockResolvedValue(intake({ startedAt: new Date(Date.now() - 31 * 60 * 1000) }))
    vi.mocked(fetchBackendJobOutcome).mockResolvedValue({ status: 'running', error: null, report: null, cards: null, message: null })
    expect((await getIntakeView(SESSION, PROJECT)).status).toBe('reading')
    expect(endIntakeReading).not.toHaveBeenCalled()
  })

  it('says what the reader may do, and counts what is unread', async () => {
    vi.mocked(requireProjectAccess).mockImplementation(async (_session, _project, permission) => {
      if (permission !== 'project:view') throw new ForbiddenError()
      return { role: 'project-viewer', closed: false, readsBecauseClosed: false }
    })

    const view = await getIntakeView(SESSION, PROJECT)

    expect(view).toMatchObject({ canDecide: false, canComplete: false, counts: { unreadDocuments: 2 } })
    expect(view.questions.map((question) => question.key)).toEqual(['geschosse_oberirdisch@bw1'])
  })

  it('is a 404 for a project set up without an intake', async () => {
    vi.mocked(findProjectIntake).mockResolvedValue(null)
    await expect(getIntakeView(SESSION, PROJECT)).rejects.toBeInstanceOf(NotFoundError)
  })
})

// ---------------------------------------------------------------------------

describe('settleIntakeOutcome', () => {
  it('fails a reading whose job failed, and queues a rerun asked for meanwhile', async () => {
    vi.mocked(findProjectIntakeByJobId).mockResolvedValue(intake())
    vi.mocked(endIntakeReading).mockResolvedValue(intake({ status: 'failed', rerunRequested: true }))

    const settled = await settleIntakeOutcome(ORG, JOB, 'failure')

    expect(endIntakeReading).toHaveBeenCalledWith(ORG, PROJECT, JOB, expect.objectContaining({ status: 'failed' }))
    expect(enqueueIntakeRead).toHaveBeenCalledWith(ORG, PROJECT, 'user_2')
    expect(settled?.status).toBe('failed')
  })

  it('leaves a reading that already finished, and knows no other job', async () => {
    vi.mocked(findProjectIntakeByJobId).mockResolvedValue(intake({ status: 'ready' }))
    expect((await settleIntakeOutcome(ORG, JOB, 'interrupted'))?.status).toBe('ready')
    expect(endIntakeReading).not.toHaveBeenCalled()

    vi.mocked(findProjectIntakeByJobId).mockResolvedValue(null)
    expect(await settleIntakeOutcome(ORG, 'other', 'failure')).toBeNull()
  })
})
