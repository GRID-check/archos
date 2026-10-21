/**
 * The bodies of the `/api/sharing/*` routes, kept out of the route files (a
 * Next route exports handlers only) so each route and the MCP catalog
 * (`lib/agent-api/catalog/collaboration.ts`) parse against one schema.
 */

import { z } from 'zod'
import { RESOURCE_ROLES, RESOURCE_VISIBILITIES } from '@/lib/sharing/sharing-vocabulary'

/** `PATCH /api/sharing/:resourceType/:resourceId`: who beyond the grants may see the resource. */
export const visibilitySchema = z.object({
  visibility: z.enum(RESOURCE_VISIBILITIES),
})

/**
 * `collaborator` is the default role for an invitee (spec SH-10) — the role that
 * lets someone actually take part, which is the point of inviting them.
 */
export const grantSchema = z.object({
  subjectUserId: z.string().min(1).max(256),
  role: z.enum(RESOURCE_ROLES).default('collaborator'),
})

/**
 * Self-escalation is a distinct, audited act rather than "grant yourself owner",
 * so it is its own body shape: a project admin taking ownership must be
 * distinguishable from a normal grant in the audit trail (spec SH-10, SH-14).
 */
export const escalateSchema = z.object({ escalate: z.literal(true) })

/** `POST …/grants`: a grant, or a project admin taking ownership. */
export const grantPostSchema = z.union([escalateSchema, grantSchema])

/** `PATCH …/grants`: a new role for a person who already holds a grant. */
export const roleChangeSchema = z.object({
  subjectUserId: z.string().min(1).max(256),
  role: z.enum(RESOURCE_ROLES),
})
