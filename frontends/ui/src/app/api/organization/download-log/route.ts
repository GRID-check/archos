/**
 * The organization's download log (ADR-0088): who took which document out, and
 * who opened one in a folder with its own access list.
 *
 * GET — `org:downloads:view` (organization admins, or a custom role given it). Newest first, paginated by
 *       an opaque `cursor`, filtered by person (`userId`), document (`document`:
 *       an id, or part of the name it had) and day (`from`, `to`). Every read is
 *       recorded in the audit trail first, and refused if it cannot be. The
 *       permission clears no folder: a row in a folder the reader may not read
 *       comes without its document and folder names (`nameWithheld`).
 * Thin handler; logic, authorization and the audit event live in
 * `@/lib/download-log/service`.
 */

import { apiRoute, parseQuery } from '@/lib/api/handler'
import { ORG_PERMISSIONS } from '@/lib/authz/permissions'
import { downloadLogQuerySchema } from '@/lib/organizations/organization-wire'
import { listDownloadLog } from '@/lib/download-log/service'

const ONE_DAY_MS = 24 * 60 * 60 * 1000

export const GET = apiRoute(
  async ({ session, request }) => {
    const { to, ...query } = parseQuery(request, downloadLogQuerySchema)
    return listDownloadLog(
      session,
      { ...query, ...(to ? { to: new Date(to.getTime() + ONE_DAY_MS) } : {}) },
      request
    )
  },
  { authz: { permission: ORG_PERMISSIONS.downloadLogView } }
)
