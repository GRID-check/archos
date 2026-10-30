/**
 * A viewpoint as data: what a mark on a 3D model is anchored to (migration
 * 0193; BCF's word for it). The wire schemas the review, the typed client and
 * an agent read, and the limits the table's CHECKs repeat.
 *
 * No `server-only`, no drizzle. All coordinates are IFC world coordinates,
 * Z-up, metres: a viewpoint means the same in any viewer. The viewer converts
 * to and from its own frame (`ui/features/bim/lib/viewpoint.ts`).
 */

import { z } from 'zod'

/** The CHECKs `annotation_viewpoints_*_bounded`. */
export const MAX_CLIPPING_PLANES = 6
export const MAX_VIEWPOINT_SELECTION = 500
export const MAX_VISIBILITY_EXCEPTIONS = 2000
export const MAX_VIEWPOINT_COLORINGS = 16
/** The CHECK `annotation_viewpoints_snapshot_bounded`: decoded bytes. */
export const MAX_SNAPSHOT_BYTES = 1_500_000
/** The encoded size the request accepts: base64 of {@link MAX_SNAPSHOT_BYTES}, rounded up. */
export const MAX_SNAPSHOT_BASE64 = 2_000_000
/** The largest body `POST …/annotations` reads: a snapshot, 2000 exceptions and 500 selected ids fit with room to spare. Bounded before JSON.parse. */
export const MAX_CREATE_BODY_BYTES = 3_000_000

export const CAMERA_KINDS = ['perspective', 'orthographic'] as const
export type CameraKind = (typeof CAMERA_KINDS)[number]

export const SNAPSHOT_CONTENT_TYPES = ['image/jpeg', 'image/png'] as const
export type SnapshotContentType = (typeof SNAPSHOT_CONTENT_TYPES)[number]

const COORDINATE_LIMIT = 1e7

const coordinate = z.number().finite()

/**
 * A point or a direction in IFC world coordinates (X east, Y north, Z up),
 * metres. Each coordinate within ±1e7: the bound is a refinement, so the JSON
 * Schema an agent reads stays short.
 */
export const vec3Schema = z
  .object({ x: coordinate, y: coordinate, z: coordinate })
  .refine(
    (v) => Math.max(Math.abs(v.x), Math.abs(v.y), Math.abs(v.z)) <= COORDINATE_LIMIT,
    'coordinate out of range'
  )
export type Vec3 = z.infer<typeof vec3Schema>

/** The 22-character compressed IFC GlobalId. */
export const globalIdSchema = z.string().regex(/^[0-9A-Za-z_$]{22}$/, 'not an IFC GlobalId')

const uniqueIds = (ids: readonly string[]) => new Set(ids).size === ids.length

const length = (v: Vec3) => Math.hypot(v.x, v.y, v.z)
const cross = (a: Vec3, b: Vec3): Vec3 => ({
  x: a.y * b.z - a.z * b.y,
  y: a.z * b.x - a.x * b.z,
  z: a.x * b.y - a.y * b.x,
})

const cameraShared = {
  position: vec3Schema,
  direction: vec3Schema,
  up: vec3Schema,
  aspectRatio: z.number().finite().min(0.1).max(10),
}

const perspectiveSchema = z
  .object({
    type: z.literal('perspective'),
    ...cameraShared,
    fieldOfView: z.number().finite().min(1).max(179),
  })
  .strict()

const orthographicSchema = z
  .object({
    type: z.literal('orthographic'),
    ...cameraShared,
    // Metres of the model the view spans vertically.
    viewToWorldScale: z.number().finite().gt(0),
  })
  .strict()

/**
 * The camera, perspective or orthographic. `position` is where it is,
 * `direction` the way it looks (not zero), `up` its up vector (not zero, not
 * parallel to direction); `aspectRatio` is width over height.
 */
export const cameraSchema = z
  .discriminatedUnion('type', [perspectiveSchema, orthographicSchema])
  .superRefine((camera, context) => {
    const direction = length(camera.direction)
    const up = length(camera.up)
    if (direction === 0)
      context.addIssue({
        code: 'custom',
        message: 'direction must not be zero',
        path: ['direction'],
      })
    if (up === 0) context.addIssue({ code: 'custom', message: 'up must not be zero', path: ['up'] })
    if (direction === 0 || up === 0) return
    if (length(cross(camera.direction, camera.up)) / (direction * up) < 1e-6) {
      context.addIssue({
        code: 'custom',
        message: 'up must not be parallel to direction',
        path: ['up'],
      })
    }
  })
export type ViewpointCamera = z.infer<typeof cameraSchema>

/** A section plane. Everything on the side `direction` points to is hidden, as BCF has it. */
export const clippingPlaneSchema = z
  .object({
    location: vec3Schema,
    // Toward the hidden half; not zero.
    direction: vec3Schema.refine((v) => length(v) > 0, 'direction must not be zero'),
  })
  .strict()
export type ClippingPlane = z.infer<typeof clippingPlaneSchema>

const colorSchema = z
  .string()
  .regex(/^[0-9A-Fa-f]{6}([0-9A-Fa-f]{2})?$/, 'a hex colour, RRGGBB or AARRGGBB')

export const componentsSchema = z
  .object({
    selection: z
      .object({
        globalIds: z
          .array(globalIdSchema)
          .max(MAX_VIEWPOINT_SELECTION)
          .refine(uniqueIds, 'each element once'),
      })
      .strict(),
    visibility: z
      .object({
        defaultVisibility: z.boolean().describe('Whether elements not in exceptions are shown.'),
        exceptions: z
          .array(globalIdSchema)
          .max(MAX_VISIBILITY_EXCEPTIONS)
          .refine(uniqueIds, 'each element once'),
      })
      .strict(),
    coloring: z
      .array(
        z
          .object({
            color: colorSchema,
            globalIds: z
              .array(globalIdSchema)
              .max(MAX_VIEWPOINT_SELECTION)
              .refine(uniqueIds, 'each element once'),
          })
          .strict()
      )
      .max(MAX_VIEWPOINT_COLORINGS),
  })
  .strict()
export type ViewpointComponents = z.infer<typeof componentsSchema>

export const pinSchema = z
  .object({
    point: vec3Schema,
    globalId: globalIdSchema.optional(),
  })
  .strict()
export type ViewpointPin = z.infer<typeof pinSchema>

export const snapshotInputSchema = z
  .object({
    contentType: z.enum(SNAPSHOT_CONTENT_TYPES),
    dataBase64: z.string().min(1).max(MAX_SNAPSHOT_BASE64),
  })
  .strict()
export type SnapshotInput = z.infer<typeof snapshotInputSchema>

/** What a mark on a model sends: the view, never the bytes of the model. */
export const viewpointInputSchema = z
  .object({
    camera: cameraSchema,
    clippingPlanes: z.array(clippingPlaneSchema).max(MAX_CLIPPING_PLANES).default([]),
    components: componentsSchema,
    pin: pinSchema.optional(),
    snapshot: snapshotInputSchema.optional(),
  })
  .strict()
  .describe(
    'A view of the model: camera, section planes, selected, hidden and coloured elements, and a snapshot.'
  )
export type ViewpointInput = z.input<typeof viewpointInputSchema>
export type ParsedViewpointInput = z.output<typeof viewpointInputSchema>

/** A viewpoint as `GET …/viewpoint` returns it. */
export const viewpointViewSchema = z.object({
  id: z.string(),
  documentId: z.string(),
  versionId: z.string().nullable(),
  camera: cameraSchema,
  clippingPlanes: z.array(clippingPlaneSchema),
  components: componentsSchema,
  pin: pinSchema.nullable(),
  hasSnapshot: z.boolean(),
  createdAt: z.string(),
})
export type ViewpointView = z.infer<typeof viewpointViewSchema>

/** The short form a mark in a list carries; the full viewpoint is fetched on demand. */
export const viewpointSummarySchema = z.object({
  id: z.string(),
  cameraKind: z.enum(CAMERA_KINDS),
  selectionCount: z.number().int(),
  hasSection: z.boolean(),
  hasSnapshot: z.boolean(),
})
export type ViewpointSummary = z.infer<typeof viewpointSummarySchema>

export const viewpointResponseSchema = z.object({ viewpoint: viewpointViewSchema })
export type ViewpointResponse = z.infer<typeof viewpointResponseSchema>
