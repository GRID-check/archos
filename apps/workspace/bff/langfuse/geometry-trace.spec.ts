/**
 * @vitest-environment node
 */
/** One geometry call is one `bim-geometry` trace with its span; a cold one also scores `geometry-cold-ms`. */
import { describe, expect, it, vi } from 'vitest'

vi.mock('server-only', () => ({}))

import { GEOMETRY_COLD_SCORE_NAME, GEOMETRY_TRACE_NAME, type GeometryCallRecord, geometryBatch } from './geometry-trace'

const ids = { traceId: 'b'.repeat(32), observationId: 'obs-1', eventIds: ['ev-1', 'ev-2', 'ev-3'] as [string, string, string] }
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
}

describe('geometryBatch', () => {
  it('writes the trace and its span with the call’s shape, never the building', () => {
    const { batch } = geometryBatch(call, ids)
    expect(batch.map((event) => event.type)).toEqual(['trace-create', 'span-create', 'score-create'])
    const trace = batch[0]?.body as { name: string; metadata: Record<string, unknown>; tags: string[] }
    expect(trace.name).toBe(GEOMETRY_TRACE_NAME)
    expect(trace.metadata).toMatchObject({ ifc_op: 'geometry:boxes', ifc_outcome: 'ok', ifc_cache_tier: 'cold', ifc_elements: 12, ifc_ms: 4200 })
    expect(trace.tags).toEqual(expect.arrayContaining(['feature:ifc', 'reader:agent', 'cache:cold']))
  })

  it('scores a cold call with the service’s milliseconds', () => {
    const score = geometryBatch(call, ids).batch[2]?.body as { name: string; value: number; traceId: string }
    expect(score).toMatchObject({ name: GEOMETRY_COLD_SCORE_NAME, value: 4200, traceId: ids.traceId })
  })

  it('scores nothing for a cached answer or a refusal', () => {
    expect(geometryBatch({ ...call, cacheTier: 'B' }, ids).batch).toHaveLength(2)
    const refused = geometryBatch({ ...call, status: 409, code: 'geometry_warming', cacheTier: null, serviceMs: null }, ids)
    expect(refused.batch).toHaveLength(2)
    expect((refused.batch[1]?.body as { level: string }).level).toBe('WARNING')
  })
})
