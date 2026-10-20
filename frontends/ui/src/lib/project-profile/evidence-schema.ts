/**
 * Where a profile value came from, and what else was found for it (ADR-0111,
 * `docs/design/agentic-project-intake.md`, „Profile fields").
 *
 * A fact or an assumption may carry `evidence`: the page a reading found it on,
 * the geocoder's hit, the derivation that computed it, or the person who
 * answered it. It may carry `alternatives`: a different value a document
 * states, kept beside the value instead of replacing it. A confirmed fact is
 * never overwritten by a reading; a contradiction lives on the fact as an
 * alternative.
 *
 * Kept apart from `types.ts` so `lib/project-intake/types.ts` can re-export
 * these without a cycle. Imports nothing from `lib/project-intake`.
 */

import { z } from 'zod'
import { ProjectPrimitiveValueSchema } from './primitive-value'

/** Most evidence entries one value, or one alternative, carries. */
export const MAX_PROFILE_EVIDENCE = 5
/** Most alternatives one fact or assumption carries. */
export const MAX_PROFILE_ALTERNATIVES = 5
/** Longest quote kept from a document, after masking (ADR-0086). */
export const MAX_EVIDENCE_QUOTE_LENGTH = 400
/** Most inputs a derivation names. The building class has seven. */
export const MAX_DERIVATION_INPUTS = 20

export const PROFILE_EVIDENCE_KINDS = ['document', 'geocoder', 'derivation', 'person'] as const
export type ProfileEvidenceKind = (typeof PROFILE_EVIDENCE_KINDS)[number]

/** The derivations the intake computes. One today; each more is a row. */
export const DERIVATION_RULES = ['gebaeudeklasse'] as const
export type DerivationRule = (typeof DERIVATION_RULES)[number]

const instant = z.string().datetime({ offset: true })

/**
 * A passage in one of the project's documents. `fileName` is the name the
 * project's files list shows; `page` is 1-based, null when the document has no
 * pages (a spreadsheet, a mail). The quote is masked before it is stored.
 */
export const documentEvidenceSchema = z.object({
  kind: z.literal('document'),
  fileName: z.string().min(1).max(512),
  page: z.number().int().min(1).nullable(),
  quote: z.string().min(1).max(MAX_EVIDENCE_QUOTE_LENGTH),
})

/** The address search's hit (`lib/geocoding`). Photon is the one adapter. */
export const geocoderEvidenceSchema = z.object({
  kind: z.literal('geocoder'),
  provider: z.literal('photon'),
  label: z.string().min(1).max(300),
  resolvedAt: instant,
})

/** One input a derivation read, and whether it was only suggested when it did. */
export const derivationInputSchema = z.object({
  key: z.string().min(1).max(200),
  value: ProjectPrimitiveValueSchema,
  suggested: z.boolean(),
})

/** A value computed from others, with the rule's Fundstelle. */
export const derivationEvidenceSchema = z.object({
  kind: z.literal('derivation'),
  rule: z.enum(DERIVATION_RULES),
  citation: z.string().min(1).max(300),
  inputs: z.array(derivationInputSchema).max(MAX_DERIVATION_INPUTS),
})

/** A person answered it themselves. */
export const personEvidenceSchema = z.object({
  kind: z.literal('person'),
  userId: z.string().min(1).max(256),
  at: instant,
})

export const profileEvidenceSchema = z.discriminatedUnion('kind', [
  documentEvidenceSchema,
  geocoderEvidenceSchema,
  derivationEvidenceSchema,
  personEvidenceSchema,
])
export type ProfileEvidence = z.infer<typeof profileEvidenceSchema>
export type DocumentEvidence = z.infer<typeof documentEvidenceSchema>
export type DerivationEvidence = z.infer<typeof derivationEvidenceSchema>
export type DerivationInput = z.infer<typeof derivationInputSchema>

/** A different value found for the same key, with where it was found. */
export const profileAlternativeSchema = z.object({
  value: ProjectPrimitiveValueSchema,
  evidence: z.array(profileEvidenceSchema).max(MAX_PROFILE_EVIDENCE),
  recordedAt: instant,
})
export type ProfileAlternative = z.infer<typeof profileAlternativeSchema>

/**
 * The two optional fields as they sit on a fact or an assumption. Lenient on
 * purpose: `salvage.ts` parses a stored profile fact by fact, and a malformed
 * evidence list must not cost the fact it is attached to. It is dropped, the
 * value is kept.
 */
export const profileEvidenceFields = {
  evidence: z.array(profileEvidenceSchema).max(MAX_PROFILE_EVIDENCE).optional().catch(undefined),
  alternatives: z.array(profileAlternativeSchema).max(MAX_PROFILE_ALTERNATIVES).optional().catch(undefined),
}
