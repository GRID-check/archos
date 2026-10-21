/**
 * The bodies of the platform settings routes, shared by the routes and the
 * agent catalog (`lib/agent-api/catalog/platform.ts`, ADR-0121). One schema, two
 * readers: a second hand-written copy is the drift ADR-0055 exists to prevent.
 */

import { z } from 'zod'
import { AGENT_GROUP_IDS, OPENROUTER_MODEL_ID_PATTERN } from '@/lib/model-config/agent-groups'
import { REASONING_EFFORTS } from '@/lib/reasoning-settings/catalog'

/** PUT /api/platform/model-defaults */
export const modelDefaultsPutSchema = z.object({
  /**
   * The complete default set. Platform defaults are always OpenRouter
   * `author/slug` ids — unlike a tenant's BYOK override, this row is served to
   * every organization, so it must be a model the platform catalog knows.
   */
  defaults: z.record(
    z.enum(AGENT_GROUP_IDS as [string, ...string[]]),
    z.object({ model: z.string().regex(OPENROUTER_MODEL_ID_PATTERN, 'not an OpenRouter model id') })
  ),
  note: z.string().trim().max(500).nullable().optional(),
})

/** PUT /api/platform/reasoning-efforts */
export const reasoningEffortsPutSchema = z.object({
  /** The complete effort set; groups omitted are cleared back to the YAML. */
  efforts: z.record(z.enum(AGENT_GROUP_IDS as [string, ...string[]]), z.enum(REASONING_EFFORTS)),
  note: z.string().trim().max(500).nullable().optional(),
})

/** PUT /api/platform/retrieval-settings */
export const retrievalSettingsPutSchema = z.object({
  /** The complete settings set: `{key: count}`. Omitted keys are cleared. */
  settings: z.record(z.string(), z.number().int()),
  note: z.string().trim().max(500).nullable().optional(),
})

const creditsSchema = z.number().min(0).finite().nullable()

/** PUT /api/platform/pricing */
export const pricingPutSchema = z.object({
  marginMultiplier: z.number().finite(),
  usdPerCredit: z.number().finite(),
  defaultOrgDailyCredits: creditsSchema,
  defaultOrgMonthlyCredits: creditsSchema,
  note: z.string().trim().max(500).nullable().optional(),
})

/** POST /api/platform/knowledge/reingest */
export const reingestKnowledgeSchema = z.object({
  fileNames: z.array(z.string()).min(1),
})
