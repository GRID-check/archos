/**
 * The write contract of permitting memory (docs/design/permitting-memory.md,
 * „Write"): what the ingest pipeline sends after a model has read a Bescheid.
 * The one description, in zod, shared by the route and the specs. Every string
 * is bounded: the model's output is untrusted input.
 *
 * No `server-only` and no drizzle runtime: the tuples are plain data.
 */

import { z } from 'zod'
import { isoDay } from '@/lib/cross-project/types'
import { normalizeProfileToken } from '@/lib/project-profile/legacy-names'
import {
  canonicalPermitRecordKind,
  canonicalPermitRequirementKind,
  PERMIT_RECORD_KINDS,
  PERMIT_REQUIREMENT_KINDS,
  PERMIT_REQUIREMENT_MAX_CHARS,
} from '@/lib/db/schema/permit-records'

/** How many requirements one document's record holds at most. */
export const PERMIT_MAX_REQUIREMENTS = 60

const text = (max: number) => z.string().trim().min(1).max(max)

export const permitRequirementSchema = z.object({
  // A worker that has not rolled yet still sends the German kinds (migration 0166).
  kind: z.preprocess(canonicalPermitRequirementKind, z.enum(PERMIT_REQUIREMENT_KINDS)),
  content: text(PERMIT_REQUIREMENT_MAX_CHARS),
  evidence: text(PERMIT_REQUIREMENT_MAX_CHARS).nullable(),
  legalBasis: text(300).nullable(),
  page: z.number().int().min(1).max(100_000).nullable(),
})

/**
 * A worker that has not rolled yet names the Land `bundesland` and sends its
 * German token (migration 0161). Read-only: nothing writes either again.
 */
function renameLegacyPermitFields(value: unknown): unknown {
  if (typeof value !== 'object' || value === null || Array.isArray(value) || !('bundesland' in value)) return value
  const { bundesland, ...rest } = value as Record<string, unknown>
  return {
    ...rest,
    federalState: typeof bundesland === 'string' ? normalizeProfileToken('federal_state', bundesland) : bundesland,
  }
}

export const permitRecordSchema = z.preprocess(renameLegacyPermitFields, z.object({
  kind: z.preprocess(canonicalPermitRecordKind, z.enum(PERMIT_RECORD_KINDS)),
  /** Null when the document does not name the issuing authority (a scan without its letterhead). */
  authority: text(300).nullable(),
  municipality: text(200).nullable(),
  federalState: text(50).nullable(),
  issuedOn: isoDay.nullable(),
  reference: text(200).nullable(),
  requirements: z.array(permitRequirementSchema).max(PERMIT_MAX_REQUIREMENTS),
}))

export const storePermitRecordRequestSchema = z.object({
  organizationId: z.string().min(1).max(200),
  /** Absent: the document is found by `collection` and `fileName` (the backfill knows no id). */
  documentId: z.guid().optional(),
  collection: z.string().min(1).max(300),
  fileName: text(512),
  /** The model that extracted it. Empty on a delete (`record: null`): nothing was extracted. */
  model: z.string().trim().max(200),
  /** Null: the document is no longer a Bescheid, or nothing was extracted. Its record goes. */
  record: permitRecordSchema.nullable(),
}).refine((body) => body.record === null || body.model.length > 0, {
  path: ['model'],
  message: 'model is required with a record',
})

export type PermitRecordBody = z.infer<typeof permitRecordSchema>
export type StorePermitRecordRequest = z.infer<typeof storePermitRecordRequestSchema>

export interface StorePermitRecordResponse {
  /** A record is stored for the document. False: the document is unknown, or the record was deleted. */
  stored: boolean
  /** How many requirements the stored record holds. */
  requirements: number
}
