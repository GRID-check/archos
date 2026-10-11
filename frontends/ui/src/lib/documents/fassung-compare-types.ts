/**
 * The wire contract of `POST /api/documents/{newer}/fassung-compare`: what Piloti
 * marks on a page between two Fassungen, and says in words (CONTEXT.md, „Fassung").
 *
 * No `server-only` and no drizzle: the route, the service and the browser hook all
 * parse with it. The reply is PARSED rather than cast on both hops (the backend's
 * answer in the service, the BFF's in the hook): a box that is not a box is dropped
 * before it can be drawn, so a model's bad coordinates never reach the page.
 */

import { z } from 'zod'

/** What the backend, and so the person, is shown when the two pages differ in nothing visible. */
export const NO_VISIBLE_CHANGE = 'keine sichtbare Änderung'

/** The page to compare is a 1-based page of both files. */
export const fassungCompareBodySchema = z.object({
  /** The document being replaced (the path's `[id]` is the newer one). */
  older: z.string().uuid(),
  page: z.number().int().min(1).max(2000).default(1),
})

/**
 * One change, boxed on the NEWER page. `x`, `y` are the top-left corner and `w`, `h`
 * the size, all page-relative `0..1` with the origin at the top left. The compare
 * view draws exactly this shape (`features/documents/components/fassung-compare`).
 */
export interface CompareRegion {
  /** 1-based page of the newer Fassung the box sits on. */
  page: number
  x: number
  y: number
  w: number
  h: number
  label: string
}

const unit = z.number().min(0).max(1)

const compareRegionSchema = z.object({
  page: z.number().int().min(1),
  x: unit,
  y: unit,
  w: unit.refine((w) => w > 0),
  h: unit.refine((h) => h > 0),
  label: z.string().trim().min(1).max(200),
})

export interface FassungVisualChanges {
  regions: CompareRegion[]
  /** Short German sentences, one per change; `[NO_VISIBLE_CHANGE]` when there is none. */
  summary: string[]
}

const MAX_REGIONS = 12
const MAX_SUMMARY_LINES = 8

/**
 * The regions and sentences of a reply, defensively. An entry that is not a valid
 * box is dropped, not repaired; the counts are bounded again here because this is
 * the last hop before a canvas. An answer with neither a box nor a sentence reads
 * as „keine sichtbare Änderung", so an empty panel never means "it failed".
 */
export function parseFassungVisualChanges(raw: unknown): FassungVisualChanges {
  const body = typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>) : {}
  const regions = (Array.isArray(body.regions) ? body.regions : [])
    .map((item) => compareRegionSchema.safeParse(item))
    .flatMap((parsed) => (parsed.success ? [parsed.data] : []))
    .slice(0, MAX_REGIONS)
  const summary = (Array.isArray(body.summary) ? body.summary : [])
    .flatMap((line) => (typeof line === 'string' && line.trim() ? [line.trim()] : []))
    .slice(0, MAX_SUMMARY_LINES)
  return { regions, summary: regions.length === 0 && summary.length === 0 ? [NO_VISIBLE_CHANGE] : summary }
}
