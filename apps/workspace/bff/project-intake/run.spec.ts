/**
 * @vitest-environment node
 */
/**
 * What a reading is submitted with (ADR-0111): the intake's own agent, the
 * job id the intake already claimed, the project's MAIN collection only (in
 * the payload and in the signed envelope alike), no project context, memory,
 * organization instructions, data sources, run row or thread, and the
 * priority of what started it.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('server-only', () => ({}))
vi.mock('@/lib/jobs/run-context', async (original) => ({
  ...(await original<typeof import('@/lib/jobs/run-context')>()),
  resolveRunContext: vi.fn(),
}))
vi.mock('@/lib/jobs/backend-client', async (original) => ({
  ...(await original<typeof import('@/lib/jobs/backend-client')>()),
  submitJob: vi.fn(async () => ({ jobId: 'intake-job-1', queued: true })),
}))
vi.mock('@/lib/request-context', async (original) => ({
  ...(await original<typeof import('@/lib/request-context')>()),
  buildRequestContextWireHeaders: vi.fn(() => ({ 'x-grid-request-context': 'signed' })),
}))

import { submitJob } from '@/lib/jobs/backend-client'
import { resolveRunContext, type RunContext } from '@/lib/jobs/run-context'
import { buildRequestContextWireHeaders } from '@/lib/request-context'
import { intakeInstruction, mintIntakeJobId, submitIntakeRun } from './run'

const PROJECT = '6f1c2d3e-4a5b-4c6d-8e7f-9a0b1c2d3e4f'

const CONTEXT: RunContext = {
  budget: null,
  modelOverrides: { chat: 'model-x' },
  collectionScope: ['base_oib', 'proj_main', 'proj_main__restricted_1'],
  projectContext: 'confirmed: federal_state=vienna',
  federalState: 'vienna',
  projectMemory: 'Memory digest',
  memoryReflectionEnabled: true,
  orgInstructions: null,
  requester: null,
}

const input = {
  organizationId: 'org-1',
  projectId: PROJECT,
  userId: 'anna',
  email: 'anna@example.test',
  collectionName: 'proj_main',
  jobId: 'intake-job-1',
  scope: 'new' as const,
  trigger: 'upload' as const,
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(resolveRunContext).mockResolvedValue(CONTEXT)
})

describe('submitIntakeRun', () => {
  it('submits the intake agent under the claimed job id, scoped to the main collection, with nothing else', async () => {
    expect(await submitIntakeRun(input)).toBe('intake-job-1')

    const [payload] = vi.mocked(submitJob).mock.calls[0]
    expect(payload).toMatchObject({
      agent_type: 'project_intake',
      job_id: 'intake-job-1',
      output: 'chat',
      skills: [],
      collection_scope: ['proj_main'],
      project_context: null,
      project_memory: null,
      memory_reflection_enabled: false,
      data_sources: null,
      organization_id: 'org-1',
      user_id: 'anna',
      project_id: PROJECT,
      owner_email: 'anna@example.test',
      model_overrides: { chat: 'model-x' },
      priority: 'bulk',
      input: intakeInstruction('new', 'upload'),
    })
    expect(payload).not.toHaveProperty('run_id')
    expect(payload).not.toHaveProperty('conversation_id')

    const [envelope] = vi.mocked(buildRequestContextWireHeaders).mock.calls[0]
    expect(envelope).toMatchObject({
      userId: 'anna',
      projectId: PROJECT,
      collectionScope: ['proj_main'],
      projectContext: null,
      projectMemory: null,
      orgInstructions: null,
      conversationId: null,
    })
    expect(envelope.issuedAt).toEqual(expect.any(Number))
  })

  it('is interactive when a person clicked', async () => {
    await submitIntakeRun({ ...input, trigger: 'click', scope: 'all' })
    expect(vi.mocked(submitJob).mock.calls[0][0]).toMatchObject({ priority: 'interactive', input: intakeInstruction('all', 'click') })
  })
})

describe('mintIntakeJobId', () => {
  it('mints an id the backend accepts as its idempotency id', () => {
    const id = mintIntakeJobId()
    expect(id).toMatch(/^[a-zA-Z0-9_-]{1,64}$/)
    expect(mintIntakeJobId()).not.toBe(id)
  })
})
