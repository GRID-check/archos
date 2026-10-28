/**
 * Project members API client
 *
 * Typed fetch client for the project's roster (`/api/projects/[id]/members`):
 * everyone the project lists, with the role each holds, if any. The overview's
 * members tile and the folder access picker both read it, so the roster is read
 * here once. Same-origin BFF route.
 *
 * Every page is read: a project past one page would otherwise lose people from
 * the picker without a word. A non-OK answer throws {@link ApiRequestError}
 * carrying the HTTP status.
 */

import { z } from 'zod'
import { collectPages } from '@/lib/api/offset-page'
import { ApiRequestError } from './api-error'

// ============================================================
// Types
// ============================================================

const ProjectMemberSchema = z.object({
  userId: z.string(),
  name: z.string(),
  email: z.string().nullable(),
  profilePictureUrl: z.string().nullable(),
  role: z.string().nullable(),
})

/** One person on the project's roster. `role` is null for someone who is listed but holds none. */
export type ProjectMember = z.infer<typeof ProjectMemberSchema>

const ProjectMembersPageSchema = z.object({
  members: z.array(ProjectMemberSchema),
  nextCursor: z.string().nullish(),
})

// ============================================================
// Reads
// ============================================================

/** The whole roster, every page, `limit` at a time. */
export const listProjectMembers = async (projectId: string): Promise<ProjectMember[]> =>
  collectPages(async (cursor) => {
    const query = new URLSearchParams({ limit: '200' })
    if (cursor) query.set('cursor', cursor)
    const response = await fetch(`/api/projects/${encodeURIComponent(projectId)}/members?${query}`)
    if (!response.ok) throw new ApiRequestError(`Failed to load the project members: ${response.status}`, response.status)
    const page = ProjectMembersPageSchema.parse(await response.json())
    return { items: page.members, nextCursor: page.nextCursor }
  })
