/**
 * Projects API — list and create projects for the current organization.
 * Thin handlers; all logic lives in `@/lib/projects/service`. A project may be
 * created directly as closed, a past one added as the office's reference
 * (ADR-0098): `closing` names how it ended, its Beginn and its Abschluss.
 */

import { z } from 'zod'
import { apiRoute, parseJsonBody } from '@/lib/api/handler'
import { ORG_PERMISSIONS } from '@/lib/authz/permissions'
import { isMonth, type Month } from '@/lib/projects/month'
import { PROJECT_OUTCOMES } from '@/lib/projects/project-status'
import { createProject, listProjects } from '@/lib/projects/service'

const monthSchema = z.custom<Month>((value) => typeof value === 'string' && isMonth(value), 'A month, YYYY-MM.')

const createProjectSchema = z
  .object({
    name: z.string().min(1).max(255).trim(),
    closing: z
      .object({
        outcome: z.enum(PROJECT_OUTCOMES),
        endedOn: monthSchema,
        startedOn: monthSchema.nullable(),
      })
      .strict()
      .optional(),
  })
  .strict()

export const GET = apiRoute(async ({ session }) => listProjects(session), {
  authz: { enforcedBy: 'listProjects (per-project FGA filter, ADR-0038)' },
})

export const POST = apiRoute(
  async ({ session, request }) => {
    const input = await parseJsonBody(request, createProjectSchema)
    return createProject(session, input, request)
  },
  { status: 201, authz: { permission: ORG_PERMISSIONS.projectsCreate } }
)
