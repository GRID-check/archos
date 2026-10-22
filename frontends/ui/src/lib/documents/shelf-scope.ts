/**
 * Which shelf a document route reads or writes: an argument, not a second
 * route (ADR-0078, ADR-0131 rule 5). `scope` is `project` (the default, with
 * `projectId`) or `office_shelf`, the office's shared shelf. The routes under
 * `/api/documents` take it in their query or body, or as `?scope=`: the old
 * `/api/office-shelf/documents/…` paths redirect there for one release
 * (`lib/api/legacy-routes.ts`).
 *
 * No `server-only` and no drizzle: the browser imports this.
 */

import { z } from 'zod'
import { BadRequestError } from '@/lib/api/errors'
import type { DocumentShelf } from './shelf'

export const SHELF_SCOPES = ['project', 'office_shelf'] as const
export type ShelfScope = (typeof SHELF_SCOPES)[number]

/** The two fields that name a shelf, spread into a route's query or body schema. */
export const shelfSelectorFields = {
  scope: z
    .enum(SHELF_SCOPES)
    .optional()
    .describe('Default `project` (with `projectId`).'),
  projectId: z.string().min(1).optional(),
}

/** The shelf a request names: its own `scope`, else `?scope=`. A project without `projectId`, or the office shelf with one, is a 400. */
export function shelfOf(selector: { scope?: ShelfScope; projectId?: string }, request: Request): DocumentShelf {
  const fromQuery = new URL(request.url).searchParams.get('scope')
  const scope = selector.scope ?? (fromQuery === 'office_shelf' ? 'office_shelf' : 'project')
  if (scope === 'office_shelf') {
    if (selector.projectId) throw new BadRequestError('projectId names a project; the office shelf takes none')
    return { kind: 'office_shelf' }
  }
  if (!selector.projectId) throw new BadRequestError('projectId is required for the project shelf')
  return { kind: 'project', projectId: selector.projectId }
}
