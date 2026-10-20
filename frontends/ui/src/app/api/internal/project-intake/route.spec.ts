/**
 * @vitest-environment node
 */
/**
 * The intake's reading talks to the BFF (`POST /api/internal/project-intake`).
 *
 * What is pinned here: the internal token is required; the project is the
 * signed envelope's and never the body's (a body naming one is refused by the
 * strict schema); a run outside a project gets a typed 422; each op reaches
 * its one service function as the envelope's pinned session, in its
 * organization's tenant scope, and its answer parses against the contract;
 * a stale reading's 409 reaches the tool with its reason. The service's own
 * rules are `lib/project-intake/service.spec.ts`.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('server-only', () => ({}))
vi.mock('@/lib/api/internal-envelope', () => ({
  requireVerifiedContext: vi.fn(),
  requirePinnedSession: vi.fn(),
}))
vi.mock('@/lib/project-intake/service', () => ({
  intakeNeeds: vi.fn(),
  recordIntakeValues: vi.fn(),
  withdrawIntakeValues: vi.fn(),
  reportIntakeProgress: vi.fn(),
  finishIntakeReading: vi.fn(),
}))
vi.mock('@/lib/db/tenant-context', async (original) => ({
  ...(await original<typeof import('@/lib/db/tenant-context')>()),
  withTenant: vi.fn((_scope: unknown, run: () => unknown) => run()),
}))

import { ConflictError } from '@/lib/api/errors'
import { requirePinnedSession, requireVerifiedContext } from '@/lib/api/internal-envelope'
import type { AuthorizedSession } from '@/lib/auth/types'
import { withTenant } from '@/lib/db/tenant-context'
import {
  finishIntakeReading,
  intakeNeeds,
  recordIntakeValues,
  withdrawIntakeValues,
  reportIntakeProgress,
} from '@/lib/project-intake/service'
import { INTERNAL_INTAKE_RESPONSE_SCHEMAS, type InternalIntakeRequest } from '@/lib/project-intake/types'
import type { VerifiedGridRequestContext } from '@/lib/request-context'
import { POST } from './route'

const SECRET = 'test-internal-token-intake'
const PROJECT = '6f1c2d3e-4a5b-4c6d-8e7f-9a0b1c2d3e4f'
const JOB = 'intake-job-1'
const SESSION = { userId: 'user_1', organizationId: 'org_1' } as Partial<AuthorizedSession> as AuthorizedSession
const CONTEXT = {
  organizationId: 'org_1',
  userId: 'user_1',
  projectId: PROJECT,
  conversationId: null,
  issuedAt: Date.now(),
  collectionScope: ['proj_main'],
} as Partial<VerifiedGridRequestContext> as VerifiedGridRequestContext

const post = (body: unknown, token = SECRET) =>
  POST(
    new Request('https://grid.test/api/internal/project-intake', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-grid-internal-token': token },
      body: JSON.stringify(body),
    })
  )

const RECORD: InternalIntakeRequest = {
  op: 'record',
  jobId: JOB,
  values: [{ key: 'bauwerkstyp@bw1', value: 'gebaeude', evidence: { fileName: 'Einreichplan.pdf', page: 2, quote: 'Wohngebäude' } }],
}

beforeEach(() => {
  vi.clearAllMocks()
  process.env.GRID_INTERNAL_API_TOKEN = SECRET
  vi.mocked(requireVerifiedContext).mockReturnValue(CONTEXT)
  vi.mocked(requirePinnedSession).mockResolvedValue(SESSION)
  vi.mocked(intakeNeeds).mockResolvedValue({ needs: [], unreadFiles: ['Einreichplan.pdf'], description: null, location: null, mode: 'active', previousSummary: null })
  vi.mocked(recordIntakeValues).mockResolvedValue({
    results: [{ key: 'bauwerkstyp@bw1', outcome: 'suggested' }],
    opened: [{ key: 'geschosse_oberirdisch@bw1', decisive: true }],
  })
  vi.mocked(withdrawIntakeValues).mockResolvedValue({ results: [{ key: 'projektphase', outcome: 'withdrawn' }] })
  vi.mocked(finishIntakeReading).mockResolvedValue({ status: 'ready' })
  vi.mocked(reportIntakeProgress).mockResolvedValue({ filesOpened: 2 })
})

afterEach(() => {
  delete process.env.GRID_INTERNAL_API_TOKEN
})

describe('POST /api/internal/project-intake', () => {
  it('needs the internal token', async () => {
    expect((await post({ op: 'needs', jobId: JOB }, 'wrong')).status).toBe(403)
    expect(intakeNeeds).not.toHaveBeenCalled()
  })

  it('answers `needs` for the envelope’s project, as its pinned session, in its tenant', async () => {
    const response = await post({ op: 'needs', jobId: JOB })

    expect(response.status).toBe(200)
    INTERNAL_INTAKE_RESPONSE_SCHEMAS.needs.parse(await response.json())
    expect(intakeNeeds).toHaveBeenCalledWith(SESSION, PROJECT, JOB)
    expect(requirePinnedSession).toHaveBeenCalledWith(CONTEXT)
    expect(withTenant).toHaveBeenCalledWith({ organizationId: 'org_1' }, expect.any(Function))
  })

  it('records values, and finishes a reading', async () => {
    const recorded = await post(RECORD)
    INTERNAL_INTAKE_RESPONSE_SCHEMAS.record.parse(await recorded.json())
    expect(recordIntakeValues).toHaveBeenCalledWith(SESSION, PROJECT, JOB, RECORD.op === 'record' ? RECORD.values : [])

    const finished = await post({ op: 'finish', jobId: JOB, summary: 'Gelesen.', documentsRead: ['Einreichplan.pdf'], traceId: 't-1' })
    expect(await finished.json()).toEqual({ status: 'ready' })
    expect(finishIntakeReading).toHaveBeenCalledWith(SESSION, PROJECT, JOB, {
      summary: 'Gelesen.',
      documentsRead: ['Einreichplan.pdf'],
      traceId: 't-1',
    })
  })

  it('withdraws the reading’s own suggestions by key', async () => {
    const withdrawn = await post({ op: 'withdraw', jobId: JOB, keys: ['projektphase'] })
    INTERNAL_INTAKE_RESPONSE_SCHEMAS.withdraw.parse(await withdrawn.json())
    expect(withdrawIntakeValues).toHaveBeenCalledWith(SESSION, PROJECT, JOB, ['projektphase'])
    expect((await post({ op: 'withdraw', jobId: JOB, keys: [] })).status).toBe(400)
  })

  it('takes the files a running reading has opened, for the live progress', async () => {
    const progress = await post({ op: 'progress', jobId: JOB, filesOpened: ['Einreichplan.pdf', 'Schnitt.pdf'] })
    INTERNAL_INTAKE_RESPONSE_SCHEMAS.progress.parse(await progress.json())
    expect(reportIntakeProgress).toHaveBeenCalledWith(SESSION, PROJECT, JOB, ['Einreichplan.pdf', 'Schnitt.pdf'])
    expect((await post({ op: 'progress', jobId: JOB, filesOpened: [''] })).status).toBe(400)
  })

  it('refuses a body that names a project, an unknown op, and a record without values', async () => {
    expect((await post({ op: 'needs', jobId: JOB, projectId: 'other' })).status).toBe(400)
    expect((await post({ op: 'delete', jobId: JOB })).status).toBe(400)
    expect((await post({ op: 'record', jobId: JOB, values: [] })).status).toBe(400)
    expect(intakeNeeds).not.toHaveBeenCalled()
    expect(recordIntakeValues).not.toHaveBeenCalled()
  })

  it('answers a typed 422 for a run outside a project', async () => {
    vi.mocked(requireVerifiedContext).mockReturnValue({ ...CONTEXT, projectId: null } as Partial<VerifiedGridRequestContext> as VerifiedGridRequestContext)
    const response = await post({ op: 'needs', jobId: JOB })
    expect(response.status).toBe(422)
    expect(await response.json()).toMatchObject({ details: { reason: 'no-project' } })
  })

  it('passes a stale reading’s 409 through with its reason', async () => {
    vi.mocked(recordIntakeValues).mockRejectedValue(new ConflictError('stale', { reason: 'stale-reading' }))
    const response = await post(RECORD)
    expect(response.status).toBe(409)
    expect(await response.json()).toMatchObject({ code: 'CONFLICT', details: { reason: 'stale-reading' } })
  })
})
