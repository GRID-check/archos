/**
 * Legal holds: preserve data and block purge (GDPR Art. 18 restriction).
 * Org-admin only. No management UI yet by design — holds are rare,
 * deliberate legal events driven via API.
 *
 * Thin handlers; all logic lives in `@/lib/compliance/service`.
 */

import { apiRoute, parseJsonBody } from '@/lib/api/handler'
import { ORG_PERMISSIONS } from '@/lib/authz/permissions'
import { createHoldSchema } from '@/lib/compliance/hold-wire'
import { createHold, listOpenHolds } from '@/lib/compliance/service'

export const GET = apiRoute(async ({ session }) => listOpenHolds(session), {
  authz: { permission: ORG_PERMISSIONS.complianceManage },
})

export const POST = apiRoute(
  async ({ session, request }) =>
    createHold(session, await parseJsonBody(request, createHoldSchema), request),
  { status: 201, authz: { permission: ORG_PERMISSIONS.complianceManage } }
)
