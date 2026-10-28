/**
 * Norm-registry schemas (ADR-0016 companion) — the curated catalog of
 * Austrian building-law pointers the agent cites.
 *
 * Hand-written to MIRROR the FIXED backend contract:
 *   GET  /v1/admin/norms         → { version, registry: NormsFile }
 *   PUT  /v1/admin/norms         ← { version, registry: NormsFile }
 *   POST /v1/admin/norms/verify  ← VerifyNormRequest → VerifyNormResponse
 *
 * `version` (outer) is the optimistic-concurrency counter; `registry.version`
 * is the on-disk file-format version (currently the literal 1). The two are
 * unrelated numbers and must not be conflated.
 */

import { z } from 'zod'
import { normalizeProfileToken } from '@/lib/project-profile/legacy-names'

/**
 * Legal rank of a pointer. The first three are RIS-backed law ranks (federal
 * act, state act, ordinance); the last two are NON-RIS ranks — authority
 * information (e.g. MA-37 Merkblätter) and external norms (ÖNORM/TRVB) that may
 * have no accessible full text.
 */
export const NORM_RANKS = [
  'federal_law',
  'state_law',
  'ordinance',
  'authority_info',
  'external_standard',
] as const
export type NormRank = (typeof NORM_RANKS)[number]

/**
 * The German ranks a stored registry (the admin-edited row, a catalog an older
 * admin tab is saving) still carries. Read-only: nothing writes these, and the
 * next save stores the English ones. Mirrored by `LEGACY_NORM_RANK` in
 * `packages/agent/src/aiq_agent/common/norm_registry.py`.
 */
export const LEGACY_NORM_RANK: Readonly<Record<string, NormRank>> = {
  bundesgesetz: 'federal_law',
  landesgesetz: 'state_law',
  verordnung: 'ordinance',
  behoerdliche_info: 'authority_info',
  norm_extern: 'external_standard',
}

export const normRankSchema = z.preprocess(
  (value) =>
    typeof value === 'string' && Object.hasOwn(LEGACY_NORM_RANK, value) ? LEGACY_NORM_RANK[value] : value,
  z.enum(NORM_RANKS)
)

/** The RIS-backed law ranks — application + document_number are required for these. */
export const LAW_RANKS = ['federal_law', 'state_law', 'ordinance'] as const
export type LawRank = (typeof LAW_RANKS)[number]

/** True when the rank is one of the three RIS-backed law ranks. */
export function isLawRank(rank: NormRank): rank is LawRank {
  return (LAW_RANKS as readonly string[]).includes(rank)
}

/**
 * Verification seed carried on an entry: the RIS query the admin curated, plus
 * optional disambiguators. `application`/`federal_state` are NOT stored here — the
 * verify call derives them from the entry itself.
 */
/**
 * A stored registry, or a verify request an older admin tab sends, names the
 * statute number `gesetzesnummer`. Read for one release (remove after); the next
 * save stores `statute_number`. Mirrored by `VerifySeed` in
 * `packages/agent/src/aiq_agent/common/norm_registry.py`.
 */
const renameLegacyStatuteNumber = (value: unknown): unknown => {
  if (typeof value !== 'object' || value === null || !('gesetzesnummer' in value)) return value
  const { gesetzesnummer, ...rest } = value as Record<string, unknown>
  return 'statute_number' in rest ? rest : { ...rest, statute_number: gesetzesnummer }
}

export const normVerifySeedSchema = z.preprocess(
  renameLegacyStatuteNumber,
  z.object({
    title_query: z.string().default(''),
    expect: z.string().optional(),
    exclude: z.array(z.string()).default([]),
    statute_number: z.string().optional(),
  })
)
export type NormVerifySeed = z.infer<typeof normVerifySeedSchema>

/**
 * A stored registry (the admin-edited row, a catalog an older admin tab is
 * saving) names the Land `bundesland`. Read-only: nothing writes that name, and
 * the next save stores `federal_state`. Mirrored by `NormEntry` in
 * `packages/agent/src/aiq_agent/common/norm_registry.py`.
 */
const renameLegacyNormEntry = (value: unknown): unknown => {
  if (typeof value !== 'object' || value === null || !('bundesland' in value)) return value
  const { bundesland, ...rest } = value as Record<string, unknown>
  return 'federal_state' in rest ? rest : { ...rest, federal_state: bundesland }
}

/** One curated law pointer. Optional fields default so a minimal entry parses. */
export const normEntrySchema = z.preprocess(renameLegacyNormEntry, z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  short: z.string().min(1),
  rank: normRankSchema,
  /** Canonical Bundesland name ('Wien'), or '' for federal law. */
  federal_state: z.string().default(''),
  topics: z.array(z.string()).default([]),
  relevance: z.string().default(''),
  /**
   * RIS consolidation application, e.g. 'LrKons' / 'BrKons'. Optional in the
   * schema but REQUIRED by the backend (400) for the three law ranks.
   */
  application: z.string().default(''),
  document_number: z.string().default(''),
  /** Plain web link for non-RIS sources (e.g. MA-37 Merkblätter). */
  source_url: z.string().default(''),
  citation_url: z.string().default(''),
  full_law_url: z.string().default(''),
  aliases: z.array(z.string()).default([]),
  /** Legal hint shown to the agent as part of the prompt. */
  binding_note: z.string().nullish(),
  /** Internal review task — never surfaced in the prompt. */
  review_note: z.string().nullish(),
  /**
   * Verify seed. The backend serializes a seedless entry as `verify: null`
   * (pydantic `VerifySeed | None`), so this MUST accept null — `.optional()`
   * alone rejects null and would fail the whole registry parse.
   */
  verify: normVerifySeedSchema.nullish(),
  verified_at: z.string().default(''),
}))
export type NormEntry = z.infer<typeof normEntrySchema>

/** `states` is keyed by the federal-state token; a stored one still has the German tokens (`wien`). */
function renameLegacyStateKeys(value: unknown): unknown {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return value
  return Object.fromEntries(
    Object.entries(value).map(([token, name]) => [normalizeProfileToken('federal_state', token), name])
  )
}

/** The persisted registry file. `version` is the file-format literal. */
export const normsFileSchema = z.object({
  version: z.literal(1),
  /** RAG base collection this country's catalog belongs to. UI preserves it verbatim. */
  corpus_collection: z.string().default('oib_knowledge'),
  /**
   * Optional CountryProfile data overrides (see aiq_agent.common.country_profile).
   * No UI surface — the admin editor preserves them verbatim across the PUT
   * round-trip so a registry that carries country-#2 overrides is not flattened.
   */
  language: z.string().default(''),
  states: z.preprocess(renameLegacyStateKeys, z.record(z.string(), z.string().nullable()).default({})),
  corpus_note: z.string().default(''),
  doctrine: z.string().default(''),
  parcel_tags: z.array(z.string()).default([]),
  entries: z.array(normEntrySchema),
})
export type NormsFile = z.infer<typeof normsFileSchema>

/** GET response and PUT request share the { version, registry } envelope. */
export const normRegistryEnvelopeSchema = z.object({
  version: z.number(),
  registry: normsFileSchema,
})
export type NormRegistryEnvelope = z.infer<typeof normRegistryEnvelopeSchema>

export const putNormRegistryBodySchema = normRegistryEnvelopeSchema
export type PutNormRegistryBody = z.infer<typeof putNormRegistryBodySchema>

/** Verify request — application is required; the rest disambiguate the query. */
export const verifyNormRequestSchema = z.preprocess(
  renameLegacyStatuteNumber,
  z.object({
    title_query: z.string().min(1),
    application: z.string().min(1),
    federal_state: z.string().optional(),
    expect: z.string().optional(),
    exclude: z.array(z.string()).optional(),
    statute_number: z.string().optional(),
  })
)
export type VerifyNormRequest = z.infer<typeof verifyNormRequestSchema>

export const verifyCandidateSchema = z.object({
  title: z.string(),
  document_number: z.string(),
  citation_url: z.string(),
  full_law_url: z.string(),
})
export type VerifyCandidate = z.infer<typeof verifyCandidateSchema>

export const verifyNormResponseSchema = z.object({
  candidates: z.array(verifyCandidateSchema),
  verified_at: z.string(),
})
export type VerifyNormResponse = z.infer<typeof verifyNormResponseSchema>
