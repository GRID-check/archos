/**
 * The bodies of the `/api/organization/llm-credentials/*` routes (ADR-0022),
 * kept out of the route files (a Next route exports handlers only) so each
 * route and the MCP catalog (`lib/agent-api/catalog/organization.ts`) parse
 * against one schema.
 */

import { z } from 'zod'
import { LLM_CREDENTIAL_PROVIDERS } from './providers'

/** `POST /api/organization/llm-credentials`. `apiKey` is write-only: no answer ever carries it. */
export const createCredentialSchema = z.object({
  provider: z.enum(LLM_CREDENTIAL_PROVIDERS),
  label: z.string().trim().min(1).max(120),
  baseUrl: z.string().trim().max(500).nullable().optional(),
  apiKey: z.string().min(8).max(512),
  rotatedFrom: z.guid().nullable().optional(),
})

/** `PUT /api/organization/llm-credentials/mode`. */
export const providerModeSchema = z.object({
  mode: z.enum(['byok', 'platform']),
})
