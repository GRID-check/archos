/**
 * Grants API — invite a person, change their role, or (for a project admin) take
 * ownership of a resource they were not party to (spec SH-3, SH-10, SH-11).
 *
 * POST creates access, PATCH changes an existing role: two verbs because the
 * invariants differ — creating is bounded by the roster cap and the container
 * precondition, changing is bounded by the last-owner rule. Thin adapters
 * (ADR-0017); every check lives in `@/lib/sharing/service`.
 */

import { captureServer } from '@/lib/analytics/posthog-server'
import { apiRoute, parseJsonBody } from '@/lib/api/handler'
import { requireCollaborationEnabled } from '@/lib/authz/feature-flags'
import { changeResourceRole, escalateToOwner, grantResourceAccess } from '@/lib/sharing/service'
import { requireShareableType } from '@/lib/sharing/registry'
import { grantPostSchema, roleChangeSchema } from '@/lib/sharing/sharing-wire'

type Params = { resourceType: string; resourceId: string }

export const POST = apiRoute<Params>(
  async ({ session, params, request }) => {
    const gated = requireCollaborationEnabled(session)
    if (gated) return gated
    const resourceType = requireShareableType(params.resourceType)
    const body = await parseJsonBody(request, grantPostSchema)

    if ('escalate' in body) {
      return escalateToOwner(session, resourceType, params.resourceId, request)
    }
    const sharing = await grantResourceAccess(session, resourceType, params.resourceId, body, request)
    // `resource_shared` (ADR-0100): the collaboration funnel's first step. A
    // grant names a person, so the audience kind is `person`; the person's id
    // stays out, the event says THAT a resource was shared and at what role.
    captureServer({
      event: 'resource_shared',
      distinctId: session.userId,
      organizationId: session.organizationId,
      properties: { resource_type: resourceType, audience_kind: 'person', role: body.role },
    })
    return sharing
  },
  { status: 201, authz: { enforcedBy: 'grantResourceAccess (requireResourceAccess owner)' } }
)

export const PATCH = apiRoute<Params>(
  async ({ session, params, request }) => {
    const gated = requireCollaborationEnabled(session)
    if (gated) return gated
    const body = await parseJsonBody(request, roleChangeSchema)
    return changeResourceRole(
      session,
      requireShareableType(params.resourceType),
      params.resourceId,
      body,
      request
    )
  },
  { authz: { enforcedBy: 'changeResourceRole (requireResourceAccess owner)' } }
)
