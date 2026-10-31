/**
 * @vitest-environment node
 */
/** The geometry body's limits, the ones the service holds too (`apps/geometry/.../wire.py`). */
import { describe, expect, it } from 'vitest'
import { GEOMETRY_LIMITS, geometryRequestSchema, usesRawCoordinates } from './geometry-wire'

const GID = '2O2Fr$t4X7Zf8NOew3FLOH'
const ids = (n: number) => Array.from({ length: n }, () => GID)
const ok = (body: unknown) => geometryRequestSchema.safeParse(body).success

describe('the geometry request', () => {
  it('takes each operation in its smallest valid form', () => {
    for (const body of [
      { op: 'boxes', globalIds: [GID] },
      { op: 'group-boxes', groups: { a: [GID] } },
      { op: 'within', aroundGlobalId: GID, margin: 1 },
      { op: 'within', box: { min: [0, 0, 0], max: [1, 1, 1] } },
      { op: 'near', globalId: GID, radius: 5 },
      { op: 'in-room', spaceGlobalId: GID },
      { op: 'neighbours', globalId: GID },
      { op: 'clash', setA: [GID], mode: 'clearance', tolerance: 4 },
      { op: 'clash', setA: [GID] },
      { op: 'diff', baseModelId: '11111111-1111-4111-8111-111111111111' },
      { op: 'warm' },
    ]) {
      expect(ok(body), JSON.stringify(body)).toBe(true)
    }
  })

  it('refuses a list past its limit', () => {
    expect(ok({ op: 'boxes', globalIds: ids(GEOMETRY_LIMITS.boxIds + 1) })).toBe(false)
    expect(ok({ op: 'boxes', globalIds: [] })).toBe(false)
    expect(ok({ op: 'clash', setA: ids(GEOMETRY_LIMITS.clashSet + 1) })).toBe(false)
    expect(ok({ op: 'group-boxes', groups: { a: ids(GEOMETRY_LIMITS.groupIds + 1) } })).toBe(false)
    const groups = Object.fromEntries(Array.from({ length: GEOMETRY_LIMITS.groups + 1 }, (_, i) => [`g${i}`, [GID]]))
    expect(ok({ op: 'group-boxes', groups })).toBe(false)
    expect(ok({ op: 'within', aroundGlobalId: GID, limit: GEOMETRY_LIMITS.resultLimit + 1 })).toBe(false)
  })

  it('refuses a distance past its limit', () => {
    expect(ok({ op: 'near', globalId: GID, radius: GEOMETRY_LIMITS.radiusM + 1 })).toBe(false)
    expect(ok({ op: 'near', globalId: GID, radius: 0 })).toBe(false)
    expect(ok({ op: 'within', aroundGlobalId: GID, margin: GEOMETRY_LIMITS.marginM + 1 })).toBe(false)
    expect(ok({ op: 'neighbours', globalId: GID, gap: GEOMETRY_LIMITS.gapM + 1 })).toBe(false)
  })

  it('bounds the clash tolerance per mode, as the engine does', () => {
    expect(ok({ op: 'clash', setA: [GID], mode: 'clearance' })).toBe(false)
    expect(ok({ op: 'clash', setA: [GID], mode: 'clearance', tolerance: GEOMETRY_LIMITS.clearanceM + 1 })).toBe(false)
    expect(ok({ op: 'clash', setA: [GID], mode: 'touch', tolerance: 0.2 })).toBe(false)
    expect(ok({ op: 'clash', setA: [GID], mode: 'intersect', tolerance: GEOMETRY_LIMITS.contactToleranceM })).toBe(true)
  })

  it('takes exactly one region or centre', () => {
    expect(ok({ op: 'within', aroundGlobalId: GID, box: { min: [0, 0, 0], max: [1, 1, 1] } })).toBe(false)
    expect(ok({ op: 'within' })).toBe(false)
    expect(ok({ op: 'near', globalId: GID, point: [0, 0, 0], radius: 1 })).toBe(false)
    expect(ok({ op: 'within', box: { min: [2, 0, 0], max: [1, 1, 1] } })).toBe(false)
  })

  it('refuses an unknown op; a malformed GlobalId is the service’s 400 (wire.py), not restated here', () => {
    expect(ok({ op: 'explode' })).toBe(false)
    expect(ok({ op: 'boxes', globalIds: ['short'] })).toBe(true)
  })

  it('names the raw-coordinate forms an agent may not send', () => {
    expect(usesRawCoordinates({ op: 'within', box: { min: [0, 0, 0], max: [1, 1, 1] } })).toBe(true)
    expect(usesRawCoordinates({ op: 'near', point: [0, 0, 0], radius: 1 })).toBe(true)
    expect(usesRawCoordinates({ op: 'within', aroundGlobalId: GID })).toBe(false)
    expect(usesRawCoordinates({ op: 'near', globalId: GID, radius: 1 })).toBe(false)
  })
})
