/**
 * The body of `POST /api/bim/models/{modelId}/geometry`: one geometry operation on one model,
 * shared by the route and the MCP catalog (`catalog/bim.ts`, `bim-model-geometry`).
 *
 * The geometry service (`apps/geometry`, ADR-0149) validates the same body again
 * (`geometry_service/wire.py`); the limits are equal on purpose, so change both together.
 * Coordinates are IFC world, Z-up, metres. Raw coordinates (`within.box`, `near.point`) are for
 * the person's UI: an agent searches around an element (`aroundGlobalId`, `globalId`), which the
 * service enforces (`geometry-service.ts`).
 */

import { z } from 'zod'

export const GEOMETRY_LIMITS = {
  boxIds: 500,
  groups: 300,
  groupIds: 200,
  resultLimit: 500,
  radiusM: 50,
  marginM: 50,
  gapM: 1,
  /** The engine's own bounds: a contact tolerance (intersect, touch) and a clearance to check. */
  contactToleranceM: 0.1,
  clearanceM: 5,
  clashSet: 2000,
  ifcTypes: 50,
  coordinateM: 1_000_000,
} as const

const L = GEOMETRY_LIMITS

// An IFC GlobalId is 22 characters; the service checks its alphabet. Kept short: every schema byte is paid per tool list.
const globalId = z.string().length(22)
const globalIds = (max: number) => z.array(globalId).min(1).max(max)
// Bounded by the service (MAX_COORDINATE_M); not restated here, where every schema byte is paid per tool list.
const coordinate = z.number()
const point = z.tuple([coordinate, coordinate, coordinate])
const limit = z.number().int().min(1).max(L.resultLimit).optional()

const box = z
  .object({ min: point, max: point })
  .refine((value) => value.min.every((low, axis) => low <= (value.max[axis] as number)), {
    message: 'box min must not exceed max on any axis',
  })

const boxes = z.object({
  op: z.literal('boxes'),
  globalIds: globalIds(L.boxIds),
})

const groupBoxes = z.object({
  op: z.literal('group-boxes'),
  groups: z
    .record(z.string().min(1).max(200), globalIds(L.groupIds))
    .refine((value) => Object.keys(value).length >= 1 && Object.keys(value).length <= L.groups, {
      message: `1 to ${L.groups} groups`,
    }),
})

const within = z
  .object({
    op: z.literal('within'),
    aroundGlobalId: globalId.optional(),
    margin: z.number().min(0).max(L.marginM).optional(),
    box: box.optional(),
    ifcTypes: z.array(z.string().min(1).max(64)).max(L.ifcTypes).optional(),
    limit,
  })
  .refine((value) => (value.box === undefined) !== (value.aroundGlobalId === undefined), {
    message: 'give exactly one of aroundGlobalId or box',
  })

const near = z
  .object({
    op: z.literal('near'),
    globalId: globalId.optional(),
    point: point.optional(),
    radius: z.number().positive().max(L.radiusM),
    limit,
  })
  .refine((value) => (value.point === undefined) !== (value.globalId === undefined), {
    message: 'give exactly one of globalId or point',
  })

const inRoom = z.object({ op: z.literal('in-room'), spaceGlobalId: globalId })

const neighbours = z.object({
  op: z.literal('neighbours'),
  globalId,
  gap: z.number().min(0).max(L.gapM).optional(),
})

const clash = z
  .object({
    op: z.literal('clash'),
    setA: globalIds(L.clashSet),
    setB: globalIds(L.clashSet).optional(),
    mode: z.enum(['intersect', 'touch', 'clearance']).optional(),
    tolerance: z.number().min(0).max(L.clearanceM).optional(),
  })
  .refine((value) => value.mode !== 'clearance' || value.tolerance !== undefined, {
    message: 'mode clearance needs tolerance: the clearance to check, in metres',
  })
  .refine((value) => value.mode === 'clearance' || (value.tolerance ?? 0) <= L.contactToleranceM, {
    message: `tolerance for intersect and touch is at most ${L.contactToleranceM} m`,
  })

const diff = z.object({
  op: z.literal('diff'),
  baseModelId: z.guid(),
  globalIds: z.array(globalId).max(L.boxIds).optional(),
})

const warm = z.object({ op: z.literal('warm') })

export const geometryRequestSchema = z.discriminatedUnion('op', [
  boxes,
  groupBoxes,
  within,
  near,
  inRoom,
  neighbours,
  clash,
  diff,
  warm,
])

export type GeometryRequest = z.infer<typeof geometryRequestSchema>
export type GeometryOp = GeometryRequest['op']

/** Which cache answered: A a resident parse, B the shared element index, cold a download and build. */
export type GeometryCacheTier = 'A' | 'B' | 'cold'

export interface GeometryMeta {
  cacheTier: GeometryCacheTier
  ms: number
  elements: number
  truncated: boolean
}

export interface GeometryResponse {
  op: GeometryOp
  result: Record<string, unknown>
  meta: GeometryMeta
}

/** Whether the request names a raw coordinate (a box or a point) rather than an element. */
export function usesRawCoordinates(request: GeometryRequest): boolean {
  return (request.op === 'within' && request.box !== undefined) || (request.op === 'near' && request.point !== undefined)
}
