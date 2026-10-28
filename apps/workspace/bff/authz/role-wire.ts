/**
 * The body both custom-role routes read (ADR-0087), kept out of the route files
 * (a Next route exports handlers only) so the routes and the MCP catalog
 * (`lib/agent-api/catalog/organization.ts`) parse against one schema. WorkOS
 * keeps names and descriptions short; these bound what the editor sends, and
 * the client reads the same limits.
 */

import { z } from 'zod'
import { ROLE_DESCRIPTION_MAX, ROLE_NAME_MAX } from '@/lib/authz/role-limits'

export const roleFieldsSchema = z.object({
  name: z.string().trim().min(1).max(ROLE_NAME_MAX),
  description: z
    .string()
    .trim()
    .max(ROLE_DESCRIPTION_MAX)
    .nullish()
    .transform((value): string | null => (value ? value : null)),
  permissions: z.array(z.string().trim().min(1).max(100)).max(50),
})

/** `POST /api/organization/roles`: every field, nothing else. */
export const createRoleSchema = roleFieldsSchema.strict()

/** `PATCH /api/organization/roles/[slug]`: only what changes; the slug never does. */
export const updateRoleSchema = roleFieldsSchema.partial().strict()
