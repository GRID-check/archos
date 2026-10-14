import { z } from 'zod'
import { profileEvidenceFields } from './evidence-schema'
import { ProjectPrimitiveValueSchema } from './primitive-value'

export { ProjectPrimitiveValueSchema } from './primitive-value'
export type { ProjectPrimitiveValue } from './primitive-value'
export type { ProfileAlternative, ProfileEvidence } from './evidence-schema'

export const ProjectFactSchema = z.object({
  value: ProjectPrimitiveValueSchema,
  confidence: z.literal('confirmed'),
  source: z.enum(['onboarding', 'user_confirmed', 'admin_edit']),
  updatedAt: z.string(),
  /** Where the value was found or who answered it (ADR-0111). Dropped, not fatal, when malformed. */
  evidence: profileEvidenceFields.evidence,
  /** A different value a document states; a contradiction, kept beside the confirmed value. */
  alternatives: profileEvidenceFields.alternatives,
})

export const ProjectAssumptionSchema = z.object({
  value: ProjectPrimitiveValueSchema,
  status: z.literal('unconfirmed'),
  reason: z.string(),
  source: z.enum(['agent_suggested', 'onboarding_default']),
  updatedAt: z.string(),
  /** Where the suggestion was found (ADR-0111). Dropped, not fatal, when malformed. */
  evidence: profileEvidenceFields.evidence,
  /** A different value found for the same key while it is still a suggestion. */
  alternatives: profileEvidenceFields.alternatives,
})

export const ProjectProfileSchema = z.object({
  facts: z.record(z.string(), ProjectFactSchema).default({}),
  goals: z.record(z.string(), ProjectPrimitiveValueSchema).default({}),
  unknowns: z.array(z.string()).default([]),
  assumptions: z.record(z.string(), ProjectAssumptionSchema).default({}),
})

export const ProjectProfileDisplaySchema = z.object({
  title: z.string(),
  summary: z.string(),
  /**
   * The UI locale the stored `summary` prose was generated in (e.g. 'en',
   * 'de'). Persisted alongside the summary — inside this jsonb blob, so no
   * column/migration — so the Project Brief can detect a stale-language summary
   * and regenerate it once when the UI locale has since changed. Optional:
   * legacy rows written before this field have no value and are treated as
   * "matches the current locale" (fail-open, never a regeneration storm).
   */
  summaryLocale: z.string().optional(),
  keyFacts: z.array(z.object({ label: z.string(), value: z.string() })),
  missingInfo: z.array(z.string()),
})

export const safePatchPath = /^\/(facts|goals|unknowns|assumptions)(\/.*)?$/

export const ProjectProfilePatchOperationSchema = z.object({
  op: z.enum(['add', 'replace', 'remove']),
  path: z
    .string()
    .refine((path) => safePatchPath.test(path), 'Unsafe project profile patch path')
    .refine((path) => !path.split('/').includes('..'), 'Path must not contain .. segments'),
  value: z.unknown().optional(),
})

export type ProjectFact = z.infer<typeof ProjectFactSchema>
export type ProjectAssumption = z.infer<typeof ProjectAssumptionSchema>
export type ProjectProfile = z.infer<typeof ProjectProfileSchema>
export type ProjectProfileDisplay = z.infer<typeof ProjectProfileDisplaySchema>
export type ProjectProfilePatchOperation = z.infer<typeof ProjectProfilePatchOperationSchema>
