/**
 * The geocoder's contract (ADR-0055): the route answers with
 * `geocodeResponseSchema`, the typed client parses with it, and the project
 * creation dialog reads `GeocodeResult`. No `server-only`: the browser imports
 * this file.
 *
 * Austria only. Piloti supports no other country, so `country` is the literal
 * `'at'` and the provider adapter drops everything outside Austria.
 */

import { z } from 'zod'
import { normalizeProfileToken } from '@/lib/project-profile/legacy-names'

/** Most suggestions one search returns. */
export const GEOCODE_MAX_LIMIT = 8
export const GEOCODE_DEFAULT_LIMIT = 5

/** What a hit is: a house number, a whole street, or a place (Gemeinde, district, POI). */
export const geocodeKindSchema = z.enum(['address', 'street', 'place'])
export type GeocodeKind = z.infer<typeof geocodeKindSchema>

/**
 * A result stored before the English names (`project_intakes.location`, migration
 * 0159) or sent by a tab that has not reloaded names the Land `bundesland` and
 * the municipality `gemeinde`, and the Land by its German token. Read-only:
 * nothing writes those names. Remove after one release.
 */
function renameLegacyGeocodeFields(value: unknown): unknown {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return value
  const { bundesland, gemeinde, ...rest } = value as Record<string, unknown>
  if (bundesland === undefined && gemeinde === undefined) return value
  return {
    ...rest,
    ...(rest.federalState === undefined && bundesland !== undefined
      ? { federalState: typeof bundesland === 'string' ? normalizeProfileToken('federal_state', bundesland) : bundesland }
      : {}),
    ...(rest.municipality === undefined && gemeinde !== undefined ? { municipality: gemeinde } : {}),
  }
}

export const geocodeResultSchema = z.preprocess(renameLegacyGeocodeFields, z.object({
  /** One display line: "Straße Nr, PLZ Ort". */
  label: z.string().min(1),
  lat: z.number().min(-90).max(90),
  lon: z.number().min(-180).max(180),
  country: z.literal('at'),
  /**
   * The intake `A2_land` token (`wien`, `niederoesterreich`, …), or null when
   * the provider named no Land we can match. The wizard's own vocabulary:
   * `FEDERAL_STATE_TOKENS` in `lib/project-profile/intake-conditions.ts`.
   */
  federalState: z.string().nullable(),
  /** The provider's state label as it reads to a person ("Niederösterreich"); Vienna is "Wien". */
  state: z.string().nullable(),
  /** City, town or village name; Vienna is "Wien". */
  municipality: z.string().nullable(),
  postcode: z.string().nullable(),
  kind: geocodeKindSchema,
}))
export type GeocodeResult = z.infer<typeof geocodeResultSchema>

/** `enabled: false` means no geocoder is configured: choose the federal state by hand. */
export const geocodeResponseSchema = z.object({
  enabled: z.boolean(),
  results: z.array(geocodeResultSchema),
})
export type GeocodeResponse = z.infer<typeof geocodeResponseSchema>

/** `GET /api/geocode?q=&limit=`. Query params arrive as strings, hence the coercion. */
export const geocodeQuerySchema = z.object({
  q: z.string().trim().min(3).max(200),
  limit: z.coerce.number().int().min(1).max(GEOCODE_MAX_LIMIT).default(GEOCODE_DEFAULT_LIMIT),
})
export type GeocodeQuery = z.infer<typeof geocodeQuerySchema>
