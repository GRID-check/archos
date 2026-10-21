/**
 * The body of `POST /api/projects/[id]/members`, kept out of the route file so
 * the route and the MCP catalog (`lib/agent-api/catalog/projects.ts`) parse
 * against one schema.
 */

import { z } from 'zod'

/**
 * The assignable project roles, mirroring `ROLES` in `lib/authz/catalog.ts`.
 * `project-contributor` was missing here, which is what made a catalog role
 * unreachable from the product: the API refused the slug, so the form could not
 * offer it and the roster could only ever show the other three.
 */
export const addMemberSchema = z.object({
  organizationMembershipId: z.string().min(1),
  roleSlug: z.union([
    z.enum(['project-viewer', 'project-contributor', 'project-editor', 'project-admin']),
    z.literal(''),
  ]),
})
