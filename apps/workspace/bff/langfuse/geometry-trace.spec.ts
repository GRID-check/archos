/**
 * @vitest-environment node
 */
/** One geometry call is one `bim-geometry` trace with its span, on the trace id the service was given. */
import { describe, expect, it, vi } from 'vitest'

vi.mock('server-only', () => ({}))

import { GEOMETRY_TRACE_NAME, type GeometryCallRecord, geometryBatch } from './geometry-trace'

const ids = { observationId: 'obs-1', eventIds: ['ev-1', 'ev-2'] as [string, string] }
const call: GeometryCallRecord = {
  op: 'boxes',
  status: 200,
  code: null,
  cacheTier: 'cold',
  elements: 12,
  serviceMs: 4200,
  truncated: false,
  reader: 'agent',
  startedAt: Date.parse('2026-10-31T09:00:00.000Z'),
  endedAt: Date.parse('2026-10-31T09:00:04.300Z'),
  organizationId: 'org_1',
  userId: 'user_1',
  traceId: 'b'.repeat(32),
}

describe('geometryBatch', () => {
  it('writes the trace and its span on the given trace id, with the call’s shape and never the building', () => {
    const { batch } = geometryBatch(call, ids)
    expect(batch.map((event) => event.type)).toEqual(['trace-create', 'span-create'])
    const trace = batch[0]?.body as { id: string; name: string; metadata: Record<string, unknown>; tags: string[] }
    expect(trace.id).toBe(call.traceId)
    expect(trace.name).toBe(GEOMETRY_TRACE_NAME)
    expect(trace.metadata).toMatchObject({ ifc_op: 'geometry:boxes', ifc_outcome: 'ok', ifc_cache_tier: 'cold', ifc_elements: 12, ifc_ms: 4200 })
    expect(trace.tags).toEqual(expect.arrayContaining(['feature:ifc', 'reader:agent', 'cache:cold']))
    expect((batch[1]?.body as { traceId: string }).traceId).toBe(call.traceId)
  })

  it('writes no score itself: the service scores a cold build when it completes', () => {
    expect(geometryBatch(call, ids).batch.some((event) => event.type === 'score-create')).toBe(false)
  })

  it('marks a refusal with its code', () => {
    const refused = geometryBatch({ ...call, status: 409, code: 'geometry_warming', cacheTier: null, serviceMs: null }, ids)
    expect((refused.batch[1]?.body as { level: string; statusMessage: string })).toMatchObject({ level: 'WARNING', statusMessage: 'geometry_warming' })
  })
})
