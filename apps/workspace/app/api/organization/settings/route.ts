/**
 * Organization settings API (app-side org record).
 *
 * GET — any member may read their org's settings.
 * PUT — `org:settings:manage` holders only; merges the provided fields.
 *       Refuses (400) keys a dedicated route owns — `zdrOnly` is switched only
 *       through `PUT /api/organization/model-config/zdr`, under
 *       `org:models:manage` — and (403) platform-owned keys. Both refusals live
 *       in `updateOrgSettings`, so no other endpoint can reopen them.
 * Thin handlers; all logic lives in `@/lib/organizations/service`.
 */

import { apiRoute, parseJsonBody } from '@/lib/api/handler'
import { ORG_PERMISSIONS } from '@/lib/authz/permissions'
import { getOrgSettings, saveOrgSettings } from '@/lib/organizations/service'
import { orgSettingsPutSchema } from '@/lib/organizations/organization-wire'

export const GET = apiRoute(
  async ({ session }) => ({ settings: await getOrgSettings(session.organizationId) }),
  {
    authz: {
      sessionOnly: true,
      why: "every member may read their own organization's settings; the read is keyed by session.organizationId and writes require org:settings:manage below",
    },
  }
)

export const PUT = apiRoute(
  async ({ session, request }) => {
    const patch = await parseJsonBody(request, orgSettingsPutSchema)
    return { settings: await saveOrgSettings(session, patch, request) }
  },
  { authz: { permission: ORG_PERMISSIONS.settingsManage } }
)
