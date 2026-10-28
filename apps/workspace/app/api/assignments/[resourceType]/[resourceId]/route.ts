/**
 * Assign / release a person on a shareable resource (ADR-0047).
 */

import { captureServer } from '@/lib/analytics/posthog-server'
import { apiRoute, parseJsonBody, parseQuery } from '@/lib/api/handler'
import { requireCollaborationEnabled } from '@/lib/authz/feature-flags'
import {
  addResourceAssignment,
  listResourceAssignments,
  removeResourceAssignment,
} from '@/lib/assignments/service'
import { assignmentBodySchema, assignmentDeleteQuerySchema } from '@/lib/assignments/assignment-wire'
import { requireShareableType } from '@/lib/sharing/registry'

type Params = { resourceType: string; resourceId: string }

export const GET = apiRoute<Params>(
  async ({ session, params }) => {
    const gated = requireCollaborationEnabled(session)
    if (gated) return gated
    const resourceType = requireShareableType(params.resourceType)
    const assignees = await listResourceAssignments(session, resourceType, params.resourceId)
    return { assignees }
  },
  { authz: { enforcedBy: 'listResourceAssignments (requireResourceAccess viewer)' } },
)

export const POST = apiRoute<Params>(
  async ({ session, params, request }) => {
    const gated = requireCollaborationEnabled(session)
    if (gated) return gated
    const { userId } = await parseJsonBody(request, assignmentBodySchema)
    const resourceType = requireShareableType(params.resourceType)
    const assignees = await addResourceAssignment(session, resourceType, params.resourceId, userId, request)
    // `task_assigned` (ADR-0100): someone was put on the hook for a resource.
    // The assignee's id stays out; the event counts the act, not the person.
    captureServer({
      event: 'task_assigned',
      distinctId: session.userId,
      organizationId: session.organizationId,
      properties: { resource_type: resourceType },
    })
    return { assignees }
  },
  { authz: { enforcedBy: 'addResourceAssignment (requireResourceAccess collaborator)' } },
)

export const DELETE = apiRoute<Params>(
  async ({ session, params, request }) => {
    const gated = requireCollaborationEnabled(session)
    if (gated) return gated
    const { userId } = parseQuery(request, assignmentDeleteQuerySchema)
    const assignees = await removeResourceAssignment(
      session,
      requireShareableType(params.resourceType),
      params.resourceId,
      userId,
      request,
    )
    return { assignees }
  },
  { authz: { enforcedBy: 'removeResourceAssignment (requireResourceAccess collaborator)' } },
)
