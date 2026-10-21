/**
 * Document roles for a project — list the bindings, declare a new one.
 * Thin handlers; authz and the vocabulary rules live in
 * `@/lib/document-roles/service`.
 */

import { apiRoute, parseJsonBody } from '@/lib/api/handler'
import { declareDocumentRole, listDocumentRoles } from '@/lib/document-roles/service'
import { loadMissingDocuments } from '@/lib/document-roles/prompt-loader'
import { declareDocumentRoleSchema } from '@/lib/document-roles/role-wire'

type Params = { id: string }

export const GET = apiRoute<Params>(
  async ({ session, params }) => ({
    roles: await listDocumentRoles(params.id, session),
    // What Piloti expects this project to hold and does not: the agent's own
    // `documents_missing:` list, so the folder brief shows the gaps the agent
    // sees. Read after `listDocumentRoles`, which has checked access.
    missing: await loadMissingDocuments(params.id, session.organizationId),
  }),
  { authz: { enforcedBy: 'listDocumentRoles (requireProjectAccess project:view)' } }
)

export const POST = apiRoute<Params>(
  async ({ session, params, request }) => {
    const body = await parseJsonBody(request, declareDocumentRoleSchema)
    return declareDocumentRole({ projectId: params.id, ...body }, session)
  },
  {
    status: 201,
    authz: {
      enforcedBy: 'declareDocumentRole (requireProjectAccess project:documents:write)',
    },
  }
)
