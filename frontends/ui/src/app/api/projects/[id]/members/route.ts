/**
 * Project members API — list the roster and assign project-level roles.
 * Thin handlers; the WorkOS FGA logic lives in `@/lib/projects/members-service`.
 */

import { apiRoute, parseJsonBody } from '@/lib/api/handler'
import { addMemberSchema } from '@/lib/projects/project-members-wire'
import { listProjectMembers, setProjectMemberRole } from '@/lib/projects/members-service'

type Params = { id: string }

export const GET = apiRoute<Params>(
  async ({ session, params }) => ({
    members: await listProjectMembers(session, params.id),
    // Which row is the reader's own, so a client can keep them from changing
    // their own access by accident (the setup's Beteiligte, ticket 26).
    viewerUserId: session.userId,
  }),
  { authz: { enforcedBy: 'listProjectMembers (requireProjectAccess project:members:manage)' } }
)

export const POST = apiRoute<Params>(
  async ({ session, params, request }) => {
    const input = await parseJsonBody(request, addMemberSchema)
    await setProjectMemberRole(session, params.id, input, request)
  },
  {
    status: 201,
    authz: { enforcedBy: 'setProjectMemberRole (requireProjectAccess project:members:manage)' },
  }
)
