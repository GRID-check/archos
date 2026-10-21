/**
 * The projects operations (ADR-0121), and the exemplar the other domain files
 * follow.
 *
 * Each entry names a route the UI already calls. The rules, in short (the long
 * form is `docs/architecture/agent-surface.md`):
 *
 * - `name` is `<entity>-<verb>`, kebab-case: `project-list`, `project-member-add`.
 * - `description` says when to call it, what comes back, and what to call next,
 *   in English, for a model. Name the identifiers it needs and where to get them.
 * - `body` IS the route's schema, imported from `lib/`. A schema that lives
 *   inside a route file moves to a `lib/<area>/*-wire.ts` module both import;
 *   a second hand-written copy is the drift ADR-0055 exists to prevent.
 * - `load` imports exactly the route file `path` names.
 * - `destructive` for anything a person confirms in the UI.
 */

import { z } from 'zod'
import { deleteProjectSchema, renameProjectSchema } from '@/lib/projects/project-wire'
import type { AgentOperation } from '../operation'

const projectParams = z.object({ id: z.string().describe('The project id, from project-list.') })

export const projectsOperations: readonly AgentOperation[] = [
  {
    name: 'project-list',
    domain: 'projects',
    summary: 'List the projects the person can see',
    description:
      'Every project the person may open in this organization, with its id, name and lifecycle status. ' +
      'Start here: most other operations take a project id from this list.',
    method: 'GET',
    path: '/api/projects',
    load: () => import('@/app/api/projects/route'),
  },
  {
    name: 'project-get',
    domain: 'projects',
    summary: 'Read one project',
    description: 'One project by id: name, status, dates and the person’s access to it.',
    method: 'GET',
    path: '/api/projects/[id]',
    params: projectParams,
    load: () => import('@/app/api/projects/[id]/route'),
  },
  {
    name: 'project-rename',
    domain: 'projects',
    summary: 'Rename a project',
    description: 'Give a project a new name. Needs the project:manage permission on that project.',
    method: 'PATCH',
    path: '/api/projects/[id]',
    params: projectParams,
    body: renameProjectSchema,
    idempotent: true,
    load: () => import('@/app/api/projects/[id]/route'),
  },
  {
    name: 'project-delete',
    domain: 'projects',
    summary: 'Move a project to the recently deleted list',
    description:
      'Soft-deletes a project; it is purged after the date the response names and can be restored until then ' +
      '(project-restore). Requires `confirmName`, the project’s exact current name, as the dialog does.',
    method: 'DELETE',
    path: '/api/projects/[id]',
    params: projectParams,
    body: deleteProjectSchema,
    load: () => import('@/app/api/projects/[id]/route'),
  },
]
