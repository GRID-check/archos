/**
 * The body of `POST /api/projects/[id]/members`, kept out of the route file so
 * the route and the MCP catalog (`lib/agent-api/catalog/projects.ts`) parse
 * against one schema.
 */

import { z } from 'zod'
import { pageQueryShape } from '@/lib/api/offset-page'

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

/**
 * `GET /api/projects/[id]/members`. `scope: "members"` (the default) lists the
 * people who hold a project role; `"organization"` lists everyone in the
 * organization, role null for those without one, to pick whom to add.
 */
export const listMembersQuerySchema = z.object({
  scope: z.enum(['members', 'organization']).optional(),
  ...pageQueryShape,
})
