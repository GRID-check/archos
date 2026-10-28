/**
 * Web search for the organization (ADR-0022): whether Piloti may search the web
 * when it answers the organization's members.
 *
 * PUT — `org:settings:manage`. The only writer of `settings.webSearchEnabled`
 *       (the generic settings save refuses the key), so the agent catalog can
 *       mark this one route a privacy control. Audited as the settings save
 *       is (`org.settings.updated`). The WorkOS `web-search` flag still has the last word
 *       (`isWebSearchEnabledForOrg`).
 */

import { apiRoute, parseJsonBody } from '@/lib/api/handler'
import { ORG_PERMISSIONS } from '@/lib/authz/permissions'
import { webSearchPutSchema } from '@/lib/organizations/organization-wire'
import { setOrgWebSearchEnabled } from '@/lib/organizations/service'

export const PUT = apiRoute(
  async ({ session, request }) => {
    const { enabled } = await parseJsonBody(request, webSearchPutSchema)
    const { webSearchEnabled } = await setOrgWebSearchEnabled(session, enabled, request)
    return { webSearchEnabled }
  },
  { authz: { permission: ORG_PERMISSIONS.settingsManage } }
)
