/**
 * Projects API — list and create projects for the current organization.
 * Thin handlers; all logic lives in `@/lib/projects/service`. A project may be
 * created directly as closed, a past one added as the office's reference
 * (ADR-0098): `closing` names how it ended, its Beginn and its Abschluss.
 * `setup` says who fills the profile: `piloti` (the default) reads the
 * documents, `self` leaves it to the wizard (ADR-0111). With `piloti` a closing
 * is carried out when the review is finished, not at creation.
 */

import { apiRoute, parseJsonBody, parseQuery } from '@/lib/api/handler'
import { ORG_PERMISSIONS } from '@/lib/authz/permissions'
import { createProjectSchema } from '@/lib/projects/create-project-schema'
import { listProjectsQuerySchema } from '@/lib/projects/project-wire'
import { projectsView } from '@/lib/projects/project-summary'
import { createProject, listProjects } from '@/lib/projects/service'

export const GET = apiRoute(
  async ({ session, request }) => {
    return projectsView(await listProjects(session), parseQuery(request, listProjectsQuerySchema))
  },
  { authz: { enforcedBy: 'listProjects (per-project FGA filter, ADR-0038)' } }
)

export const POST = apiRoute(
  async ({ session, request }) => {
    const input = await parseJsonBody(request, createProjectSchema)
    return createProject(session, input, request)
  },
  { status: 201, authz: { permission: ORG_PERMISSIONS.projectsCreate } }
)
