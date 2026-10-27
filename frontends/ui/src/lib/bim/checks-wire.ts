/**
 * The bodies of `POST` and `DELETE /api/projects/[id]/bim/checks`, kept out of
 * the route file (a Next route exports handlers only) so the route and the MCP
 * catalog (`lib/agent-api/catalog/bim.ts`) parse against one schema.
 */

import { z } from 'zod'

const RULE_ID = z.string().trim().min(1).max(120)

export const confirmCheckSchema = z.object({
  ruleId: RULE_ID,
  /** The revision the person looked at; re-resolved against the tenant. */
  modelId: z.guid(),
  note: z.string().trim().max(2000).nullish(),
})

// `modelId` is required, because a confirmation is keyed per revision (0045):
// a project holds several buildings, and "withdraw rule X" with no building
// named would take back the wrong signature — or every one of them.
export const withdrawCheckSchema = z.object({ ruleId: RULE_ID, modelId: z.guid() })
