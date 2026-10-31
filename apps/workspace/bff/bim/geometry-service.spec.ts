/**
 * @vitest-environment node
 */
/**
 * Who may ask for a model's geometry: the model's document read gate decides, before the geometry
 * service is called, for the model and for a diff's base model; an agent never sends a coordinate.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('server-only', () => ({}))

const getAccessibleModel = vi.fn()
vi.mock('./model-service', () => ({ getAccessibleModel: (...args: unknown[]) => getAccessibleModel(...args) }))
const callGeometry = vi.fn()
vi.mock('./geometry-client', async (importActual) => ({
  ...(await importActual<typeof import('./geometry-client')>()),
  callGeometry: (...args: unknown[]) => callGeometry(...args),
}))
const actingReaderIsAgent = vi.fn(() => false)
vi.mock('@/lib/agent-api/acting-session', () => ({ actingReaderIsAgent: () => actingReaderIsAgent() }))
const recordGeometryTrace = vi.fn(async (..._args: unknown[]) => {})
vi.mock('@/lib/langfuse/geometry-trace', () => ({ recordGeometryTrace: (...args: unknown[]) => recordGeometryTrace(...args) }))

import { NotFoundError } from '@/lib/api/errors'
import type { AuthorizedSession } from '@/lib/auth/types'
import { GeometryServiceError } from './geometry-client'
import type { GeometryRequest } from './geometry-wire'
import { AGENT_COORDINATES_REFUSAL, geometryForAccessibleModel } from './geometry-service'

const MODEL = '11111111-1111-4111-8111-111111111111'
const BASE = '22222222-2222-4222-8222-222222222222'
const GID = '2O2Fr$t4X7Zf8NOew3FLOH'
const session = { userId: 'user_1', organizationId: 'org_1' } as AuthorizedSession
const answer = { op: 'boxes', result: { boxes: [] }, meta: { cacheTier: 'B', ms: 3, elements: 0, truncated: false } }

beforeEach(() => {
  vi.clearAllMocks()
  actingReaderIsAgent.mockReturnValue(false)
  getAccessibleModel.mockImplementation(async (_s: unknown, id: string) => ({ id, projectId: 'project_1' }))
  callGeometry.mockResolvedValue(answer)
})

describe('geometryForAccessibleModel', () => {
  it('passes the document read gate, then calls the service with the model’s project', async () => {
    await expect(geometryForAccessibleModel(session, MODEL, { op: 'boxes', globalIds: [GID] })).resolves.toEqual(answer)
    expect(getAccessibleModel).toHaveBeenCalledWith(session, MODEL)
    const caller = callGeometry.mock.calls[0]?.[2] as { traceId: string }
    expect(callGeometry).toHaveBeenCalledWith(MODEL, { op: 'boxes', globalIds: [GID] }, {
      organizationId: 'org_1',
      userId: 'user_1',
      projectId: 'project_1',
      traceId: expect.stringMatching(/^[0-9a-f]{32}$/),
    })
    // The trace the service scores a cold build on is the one the BFF records the call on.
    expect(recordGeometryTrace).toHaveBeenCalledWith(
      expect.objectContaining({ op: 'boxes', status: 200, cacheTier: 'B', reader: 'person', traceId: caller.traceId })
    )
  })

  it('calls nothing for a model the gate does not let through', async () => {
    getAccessibleModel.mockRejectedValue(new NotFoundError('Model not found'))
    await expect(geometryForAccessibleModel(session, MODEL, { op: 'warm' })).rejects.toMatchObject({ status: 404 })
    expect(callGeometry).not.toHaveBeenCalled()
  })

  it('passes the gate for a diff’s base model too', async () => {
    getAccessibleModel.mockImplementation(async (_s: unknown, id: string) => {
      if (id === BASE) throw new NotFoundError('Model not found')
      return { id, projectId: 'project_1' }
    })
    await expect(geometryForAccessibleModel(session, MODEL, { op: 'diff', baseModelId: BASE })).rejects.toMatchObject({ status: 404 })
    expect(callGeometry).not.toHaveBeenCalled()
  })

  it('refuses a raw coordinate from an agent, before any access check', async () => {
    actingReaderIsAgent.mockReturnValue(true)
    const box: GeometryRequest = { op: 'within', box: { min: [0, 0, 0], max: [1, 1, 1] } }
    await expect(geometryForAccessibleModel(session, MODEL, box)).rejects.toMatchObject({ status: 400, message: AGENT_COORDINATES_REFUSAL })
    await expect(geometryForAccessibleModel(session, MODEL, { op: 'near', point: [0, 0, 0], radius: 2 })).rejects.toMatchObject({ status: 400 })
    expect(getAccessibleModel).not.toHaveBeenCalled()
    await geometryForAccessibleModel(session, MODEL, { op: 'within', aroundGlobalId: GID, margin: 1 })
    expect(callGeometry).toHaveBeenCalledTimes(1)
  })

  it('states a diff base model’s own project, which may differ from the model’s', async () => {
    getAccessibleModel.mockImplementation(async (_s: unknown, id: string) => ({ id, projectId: id === BASE ? 'project_2' : 'project_1' }))
    await geometryForAccessibleModel(session, MODEL, { op: 'diff', baseModelId: BASE })
    expect(callGeometry.mock.calls[0]?.[2]).toMatchObject({ projectId: 'project_1', baseProjectId: 'project_2' })
  })

  it('lets the person’s viewer send a box', async () => {
    await geometryForAccessibleModel(session, MODEL, { op: 'within', box: { min: [0, 0, 0], max: [1, 1, 1] } })
    expect(callGeometry).toHaveBeenCalledTimes(1)
  })

  it('answers warming as 409 geometry_warming with retryAfter, and records the refusal', async () => {
    callGeometry.mockRejectedValue(new GeometryServiceError('warming', 409, 'geometry_warming', 12))
    await expect(geometryForAccessibleModel(session, MODEL, { op: 'warm' })).rejects.toMatchObject({
      status: 409,
      code: 'geometry_warming',
      details: { retryAfter: 12 },
    })
    expect(recordGeometryTrace).toHaveBeenCalledWith(expect.objectContaining({ status: 409, code: 'geometry_warming' }))
  })
})
