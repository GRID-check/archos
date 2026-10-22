/**
 * What Piloti has learned about the office's conventions (ADR-0129).
 *
 * GET  — any member may read the lines: the same conventions reach every
 *        member's answers, so they are no secret from them. Keyed by
 *        `session.organizationId`.
 * POST — confirm or decline one line, or take the decision back. It decides
 *        what Piloti says to everyone in the organization, so it takes
 *        `org:settings:manage`, like the standing instructions.
 *
 * Thin handlers; the logic is `@/lib/office-conventions/service`.
 */

import { apiRoute, parseJsonBody } from '@/lib/api/handler'
import { ORG_PERMISSIONS } from '@/lib/authz/permissions'
import { decideOfficeConvention, listOfficeConventions } from '@/lib/office-conventions/service'
import { decideConventionBodySchema } from '@/lib/office-conventions/office-conventions-wire'

export const GET = apiRoute(async ({ session }) => listOfficeConventions(session.organizationId), {
  authz: {
    sessionOnly: true,
    why: "every member's answers carry the office's conventions, so every member may read them; the read is keyed by session.organizationId and deciding requires org:settings:manage below",
  },
})

export const POST = apiRoute(
  async ({ session, request }) => {
    const input = await parseJsonBody(request, decideConventionBodySchema)
    await decideOfficeConvention(session.organizationId, session.userId, input)
    return listOfficeConventions(session.organizationId)
  },
  { authz: { permission: ORG_PERMISSIONS.settingsManage } }
)
