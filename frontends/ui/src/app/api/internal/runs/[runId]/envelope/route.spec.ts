/**
 * @vitest-environment node
 */
/**
 * The run-envelope route with its real service behind it (ADR-0108).
 *
 * The worker names a run and gets back a credential that acts as a person for
 * six hours, so the assertions that matter are the refusals: an unknown run, an
 * ended run, a requester who left, lost the right, or whose organization lost
 * the capability, and a conversation they may no longer view. Each answers in
 * the contract's `{error, message}` shape (`run-envelope-types.ts`), parsed
 * here with the same schema the worker's client is generated from. The success
 * case verifies the envelope with the BFF's own verifier, so „it signs" means
 * „a write route would accept it", not „it returned a string".
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/tasks/repository', () => ({ findRunById: vi.fn() }))
vi.mock('@/lib/auth/pinned-session', () => ({ resolvePinnedRequesterSession: vi.fn() }))
vi.mock('@/lib/authz/projects', () => ({ requireProjectAccess: vi.fn() }))
vi.mock('@/lib/retrieval-scope/collection-scope-request', () => ({ authorizeConversationScope: vi.fn() }))
// Partial: the input the envelope is signed from is the real one, so the
// success case proves the renewal signs what the submission signs.
vi.mock('@/lib/jobs/run-context', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/jobs/run-context')>()),
  resolveRunContext: vi.fn(),
}))
vi.mock('@/lib/workos/feature-flags', () => ({ isOrgFeatureEnabled: vi.fn() }))
vi.mock('@/lib/audit/service', () => ({ recordAuditEvent: vi.fn() }))

import { NotFoundError, ResourceRightsLostError } from '@/lib/api/errors'
import { recordAuditEvent } from '@/lib/audit/service'
import { resolvePinnedRequesterSession } from '@/lib/auth/pinned-session'
import type { AuthorizedSession } from '@/lib/auth/types'
import { FEATURE_FLAGS } from '@/lib/authz/feature-flags'
import { requireProjectAccess } from '@/lib/authz/projects'
import { authorizeConversationScope } from '@/lib/retrieval-scope/collection-scope-request'
import type { TaskRun } from '@/lib/db/schema'
import { resolveRunContext, type RunContext } from '@/lib/jobs/run-context'
import { GRID_REQUEST_CONTEXT_MAX_AGE_MS, verifyGridRequestContextEnvelope } from '@/lib/request-context'
import { capabilityOf } from '@/lib/runs/run-envelope'
import { runEnvelopeErrorSchema, runEnvelopeResponseSchema } from '@/lib/runs/run-envelope-types'
import { findRunById } from '@/lib/tasks/repository'
import { isOrgFeatureEnabled } from '@/lib/workos/feature-flags'
import { POST } from './route'

const SECRET = 'internal-token-for-tests' // pragma: allowlist secret
const RUN = '6f1a0f7e-2b1f-4a4e-9a4e-2f0f1a6d9c31'
const PROJECT = '33333333-3333-4333-8333-333333333333'
const CONVERSATION = 's_conv_1'

const run = {
  id: RUN,
  organizationId: 'org_1',
  projectId: PROJECT,
  definitionId: 'def-1',
  kind: 'deep-research',
  title: 'Fluchtwege prüfen',
  requesterUserId: 'user_requester',
  requesterEmail: 'r@grid.test',
  trigger: 'schedule',
  status: 'running',
  conversationId: CONVERSATION,
  plan: { prompt: 'Fluchtwege prüfen, OIB-RL 4' },
} as unknown as TaskRun

const runContext: RunContext = {
  budget: { remainingOrgUsd: 12.5, remainingUserUsd: null, remainingProjectUsd: null },
  modelOverrides: { deep_research: 'model-b' },
  collectionScope: ['oib_base', 'proj_x'],
  projectContext: 'federal_state=vienna',
  federalState: 'vienna',
  projectMemory: null,
  memoryReflectionEnabled: true,
  orgInstructions: 'Antworte knapp.',
  requester: { name: 'Anna Weber', email: 'r@grid.test', organizationName: 'Atelier Nord' },
}

const session: AuthorizedSession = {
  userId: 'user_requester',
  email: 'r@grid.test',
  name: null,
  accessToken: '',
  organizationId: 'org_1',
  organizationMembershipId: 'om_1',
  role: 'member',
  permissions: [],
  featureFlags: [],
}

const member = { role: 'project-editor', closed: false, readsBecauseClosed: false } as const

function call(runId: string = RUN, init: { body?: string; token?: string | null } = {}) {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  if (init.token !== null) headers['x-grid-internal-token'] = init.token ?? SECRET
  return POST(
    new Request(`https://grid.test/api/internal/runs/${runId}/envelope`, {
      method: 'POST',
      headers,
      ...(init.body !== undefined ? { body: init.body } : {}),
    }),
    { params: Promise.resolve({ runId }) },
  )
}

/** A refusal, parsed with the contract's own schema: status and code. */
async function refusalOf(response: Response) {
  return { status: response.status, ...runEnvelopeErrorSchema.parse(await response.json()) }
}

beforeEach(() => {
  vi.clearAllMocks()
  process.env.GRID_INTERNAL_API_TOKEN = SECRET
  vi.mocked(findRunById).mockResolvedValue(run)
  vi.mocked(resolvePinnedRequesterSession).mockResolvedValue(session)
  vi.mocked(isOrgFeatureEnabled).mockResolvedValue(true)
  vi.mocked(requireProjectAccess).mockResolvedValue(member)
  vi.mocked(authorizeConversationScope).mockResolvedValue(true)
  vi.mocked(resolveRunContext).mockResolvedValue(runContext)
})

describe('POST /api/internal/runs/[runId]/envelope', () => {
  it('signs a fresh envelope that names the requester, the project and the conversation', async () => {
    const before = Date.now()
    const response = await call()
    expect(response.status).toBe(200)
    expect(response.headers.get('cache-control')).toBe('no-store')
    const envelope = runEnvelopeResponseSchema.parse(await response.json())

    expect(envelope.issuedAt).toBeGreaterThanOrEqual(before)
    expect(envelope.issuedAt).toBeLessThanOrEqual(Date.now())
    // What a write route would read: the BFF's own verifier, the same secret.
    const verified = verifyGridRequestContextEnvelope(envelope.header, envelope.signature, SECRET)
    expect(verified).toEqual({
      organizationId: 'org_1',
      userId: 'user_requester',
      projectId: PROJECT,
      conversationId: CONVERSATION,
      issuedAt: envelope.issuedAt,
      collectionScope: ['oib_base', 'proj_x'],
    })
    // The run's context rides along: the agent reads a signed envelope
    // wholesale, so a renewal without it would drop the models and the budget.
    const payload = JSON.parse(Buffer.from(envelope.header, 'base64url').toString('utf8'))
    expect(payload).toMatchObject({
      modelOverrides: { deep_research: 'model-b' },
      budget: { remainingOrgUsd: 12.5 },
      federalState: 'vienna',
      memoryReflectionEnabled: true,
      orgInstructions: 'Antworte knapp.',
      // Who the run acts as, by name, read afresh at every renewal: nobody is
      // signed in, so no token can say it.
      requester: { name: 'Anna Weber', email: 'r@grid.test', organizationName: 'Atelier Nord' },
    })
    // Inside the window for its whole six hours, and not one millisecond more.
    const end = envelope.issuedAt + GRID_REQUEST_CONTEXT_MAX_AGE_MS
    expect(verifyGridRequestContextEnvelope(envelope.header, envelope.signature, SECRET, end)).not.toBeNull()
    expect(verifyGridRequestContextEnvelope(envelope.header, envelope.signature, SECRET, end + 1)).toBeNull()
  })

  it('resolves the requester from the ROW and checks the rights a chat turn needs', async () => {
    await call()

    expect(resolvePinnedRequesterSession).toHaveBeenCalledWith({
      userId: 'user_requester',
      email: 'r@grid.test',
      organizationId: 'org_1',
    })
    expect(requireProjectAccess).toHaveBeenCalledWith(session, PROJECT, ['project:chat', 'project:edit'])
    expect(authorizeConversationScope).toHaveBeenCalledWith(session, CONVERSATION)
    expect(resolveRunContext).toHaveBeenCalledWith(
      { organizationId: 'org_1', projectId: PROJECT, userId: 'user_requester' },
      'Fluchtwege prüfen, OIB-RL 4',
    )
  })

  it('audits the renewal as the requester, without the envelope', async () => {
    await call()

    expect(recordAuditEvent).toHaveBeenCalledTimes(1)
    const event = vi.mocked(recordAuditEvent).mock.calls[0][0]
    expect(event).toMatchObject({
      organizationId: 'org_1',
      actor: { userId: 'user_requester', email: 'r@grid.test' },
      action: 'task.envelope_renewed',
      targetType: 'task',
      targetId: RUN,
      metadata: { projectId: PROJECT, kind: 'deep-research', trigger: 'schedule' },
    })
    expect(JSON.stringify(event)).not.toMatch(/header|signature/i)
  })

  it('signs no conversation when the row is gone, and refuses one the requester may no longer view', async () => {
    vi.mocked(authorizeConversationScope).mockResolvedValueOnce(false)
    const response = await call()
    const { header, signature } = runEnvelopeResponseSchema.parse(await response.json())
    expect(verifyGridRequestContextEnvelope(header, signature, SECRET)?.conversationId).toBeNull()

    vi.mocked(authorizeConversationScope).mockRejectedValueOnce(new ResourceRightsLostError('conversation'))
    expect(await refusalOf(await call())).toMatchObject({ status: 403, error: 'requester-may-not-act' })
  })

  it('answers 404 unknown-run for a run that does not exist, and for an id that is not one', async () => {
    vi.mocked(findRunById).mockResolvedValueOnce(null)
    expect(await refusalOf(await call())).toMatchObject({ status: 404, error: 'unknown-run' })

    expect(await refusalOf(await call('not-a-uuid'))).toMatchObject({ status: 404, error: 'unknown-run' })
    // Refused before the database: a uuid column would have thrown, not answered.
    expect(findRunById).toHaveBeenCalledTimes(1)
  })

  it.each(['succeeded', 'failed', 'interrupted', 'skipped', 'error'])(
    'answers 409 run-not-active for a %s run, before asking who the requester is',
    async (status) => {
      vi.mocked(findRunById).mockResolvedValueOnce({ ...run, status } as TaskRun)
      expect(await refusalOf(await call())).toMatchObject({ status: 409, error: 'run-not-active' })
      expect(resolvePinnedRequesterSession).not.toHaveBeenCalled()
    },
  )

  it('renews a queued run as well as a running one', async () => {
    vi.mocked(findRunById).mockResolvedValueOnce({ ...run, status: 'queued' } as TaskRun)
    expect((await call()).status).toBe(200)
  })

  it('answers 403 requester-may-not-act for a requester who left the organization', async () => {
    vi.mocked(resolvePinnedRequesterSession).mockResolvedValueOnce(null)
    expect(await refusalOf(await call())).toMatchObject({ status: 403, error: 'requester-may-not-act' })
    expect(recordAuditEvent).not.toHaveBeenCalled()
  })

  it('answers 403 requester-may-not-act for a requester who lost the right to chat in the project', async () => {
    vi.mocked(requireProjectAccess).mockRejectedValueOnce(new NotFoundError())
    expect(await refusalOf(await call())).toMatchObject({ status: 403, error: 'requester-may-not-act' })
  })

  it('refuses a requester who reaches the project only because it is closed', async () => {
    vi.mocked(requireProjectAccess).mockResolvedValueOnce({
      role: 'project-viewer',
      closed: true,
      readsBecauseClosed: true,
    })
    expect(await refusalOf(await call())).toMatchObject({ status: 403, error: 'requester-may-not-act' })
  })

  it('answers 403 requester-may-not-act when the organization lost the capability', async () => {
    vi.mocked(isOrgFeatureEnabled).mockResolvedValueOnce(false)
    expect(await refusalOf(await call())).toMatchObject({ status: 403, error: 'requester-may-not-act' })
    expect(isOrgFeatureEnabled).toHaveBeenCalledWith(FEATURE_FLAGS.skills, 'org_1')
  })

  it('lets an outage through as a 5xx rather than as a verdict', async () => {
    vi.mocked(requireProjectAccess).mockRejectedValueOnce(new Error('WorkOS unreachable'))
    const response = await call()
    expect(response.status).toBeGreaterThanOrEqual(500)
  })

  it('refuses a request without the service token, before the row is read', async () => {
    const response = await call(RUN, { token: null })
    expect(response.status).toBeGreaterThanOrEqual(401)
    expect(response.status).toBeLessThan(500)
    expect(findRunById).not.toHaveBeenCalled()
  })

  it('takes an empty body or {}, and refuses a body that names anything', async () => {
    expect((await call(RUN, { body: '' })).status).toBe(200)
    expect((await call(RUN, { body: '{}' })).status).toBe(200)

    const naming = await call(RUN, { body: JSON.stringify({ userId: 'user_someone_else' }) })
    expect(naming.status).toBe(400)
    expect((await call(RUN, { body: '{' })).status).toBe(400)
    expect(findRunById).toHaveBeenCalledTimes(2)
  })
})

describe('capabilityOf', () => {
  it('asks for the gate the run was admitted under', () => {
    expect(capabilityOf({ trigger: 'schedule', kind: 'chat', definitionId: 'def-1' })).toBe(FEATURE_FLAGS.skills)
    expect(capabilityOf({ trigger: 'manual', kind: 'deep-research', definitionId: 'def-1' })).toBe(
      FEATURE_FLAGS.skills,
    )
    expect(capabilityOf({ trigger: 'delegated', kind: 'deep-research', definitionId: null })).toBe(
      FEATURE_FLAGS.deepResearch,
    )
    expect(capabilityOf({ trigger: 'delegated', kind: 'submission_check', definitionId: 'def-1' })).toBe(
      FEATURE_FLAGS.taskAutomation,
    )
  })
})
