import { apiRoute } from '@/lib/api/handler'
import { getProjectStandards } from '@/lib/projects/service'

export const GET = apiRoute<{ id: string }>(
  async ({ session, params }) => getProjectStandards(session, params.id),
  { authz: { enforcedBy: 'getProjectStandards (requireProjectAccess project:view)' } }
)
