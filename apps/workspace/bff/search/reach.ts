/**
 * What one person may read, for one search (ADR-0136): computed once, from the
 * gates the listing already uses, and handed to every provider. No provider
 * asks a gate of its own, so the kinds cannot disagree about a project.
 *
 * - Projects: `listProjects` (`project:view`, a closed project as
 *   `requireProjectAccess` decides it), or `requireProjectAccess` for one.
 * - Folders: `getProjectFolderAccess`, the folders hidden from this person
 *   (restricted ones they are not cleared for, and every deleted one) and the
 *   restricted collections they may search (ADR-0087, ADR-0088).
 * - Held uploads: `shelfReaderFor` per shelf, folded into the `projects` reader
 *   the projects grid counts with (ADR-0086).
 * - The office shelf: every member reads it.
 */

import 'server-only'
import { and, eq, isNull, like, or } from 'drizzle-orm'
import { BadRequestError, NotFoundError } from '@/lib/api/errors'
import type { AuthorizedSession } from '@/lib/auth/types'
import { getProjectFolderAccess, getRestrictedFolderIds } from '@/lib/authz/folder-access'
import { requireProjectAccess } from '@/lib/authz/projects'
import { getDb } from '@/lib/db'
import { projectFolders } from '@/lib/db/schema/project-folders'
import type { Project } from '@/lib/db/schema/projects'
import { withTenant } from '@/lib/db/tenant-context'
import { SCREENED_ONLY, type DocumentReader } from '@/lib/documents/document-reader'
import { OFFICE_SHELF, projectShelf, shelfFolderWhere, type DocumentShelf } from '@/lib/documents/shelf'
import { officeShelfCollectionName } from '@/lib/office-shelf/collection'
import { audienceReach } from '@/lib/cross-project/audience-reach'
import { readConversationAudience } from '@/lib/conversations/restricted-use-repository'
import { findProjectInOrg } from '@/lib/projects/repository'
import { listProjects } from '@/lib/projects/service'
import { escapeLikePattern } from '@/lib/text/like-pattern'
import { shelfReaderFor } from '@/lib/upload-screening/quarantine-reviewers'
import { inPool } from '@/lib/utils/in-pool'
import type { SearchScope } from './search-wire'

/** One project the person may read, with what they may read of it. */
export interface ReachedProject {
  project: Project
  hiddenFolderIds: readonly string[]
  /** The project's collection and every restricted one they are cleared for. */
  collections: readonly string[]
  reviewsQuarantine: boolean
}

export interface SearchReach {
  organizationId: string
  userId: string
  scope: SearchScope
  projects: readonly ReachedProject[]
  /** The office shelf, when the scope covers it. */
  officeShelf: { collection: string; reviewsQuarantine: boolean } | null
  /** With a folder scope: the folder and its subfolders. */
  folderIds: readonly string[] | null
  /**
   * Only documents whose screening passed (`SCREENED_ONLY`, ADR-0086): set for
   * a conversation's audience that is more than its asker, where an upload held
   * for the asker alone must not reach the other readers.
   */
  screenedOnly?: boolean
  /**
   * The reach was cut to named projects (a `projectIds` filter): no office
   * shelf, and no conversation outside those projects.
   */
  narrowedToProjects?: boolean
}

/** Projects whose folder access is read at once. Each is a tenancy probe and a folder-tree read. */
const PROJECTS_AT_ONCE = 8

/** Resolve a scope query to a scope; a folder needs its shelf. */
export function resolveScope(query: { scope?: 'office' | 'project' | 'office_shelf'; projectId?: string; folderId?: string }): SearchScope {
  if (query.projectId && (query.scope === undefined || query.scope === 'project')) {
    return { kind: 'project', projectId: query.projectId, ...(query.folderId ? { folderId: query.folderId } : {}) }
  }
  if (query.scope === 'office_shelf') return { kind: 'office_shelf', ...(query.folderId ? { folderId: query.folderId } : {}) }
  if (query.scope === 'project') throw new BadRequestError('projectId is required for the project scope')
  if (query.folderId) throw new BadRequestError('A folder is searched inside its project or the office shelf: pass projectId or scope=office_shelf')
  if (query.projectId) throw new BadRequestError('projectId names a project; the office shelf takes none')
  return { kind: 'office' }
}

async function reachProject(session: AuthorizedSession, project: Project): Promise<ReachedProject> {
  const [access, reader] = await Promise.all([
    getProjectFolderAccess(session, project.id, project.collectionName),
    shelfReaderFor(session, { scope: 'project', projectId: project.id }),
  ])
  return {
    project,
    hiddenFolderIds: [...access.hiddenFolderIds],
    collections: [project.collectionName, ...access.clearedRestrictedCollections],
    reviewsQuarantine: reader.kind === 'reviewer',
  }
}

async function reachOfficeShelf(session: AuthorizedSession): Promise<NonNullable<SearchReach['officeShelf']>> {
  const reader = await shelfReaderFor(session, { scope: 'office_shelf', projectId: null })
  return { collection: officeShelfCollectionName(session.organizationId), reviewsQuarantine: reader.kind === 'reviewer' }
}

/**
 * A folder and its subfolders on `shelf`, refused like a folder that does not
 * exist when it is hidden from this person or on another shelf.
 */
async function folderSubtree(
  organizationId: string,
  shelf: DocumentShelf,
  folderId: string,
  hidden: readonly string[]
): Promise<string[]> {
  if (hidden.includes(folderId)) throw new NotFoundError('Folder not found')
  const db = getDb()
  const [root] = await withTenant({ organizationId }, () =>
    db
      .select({ path: projectFolders.path })
      .from(projectFolders)
      .where(and(shelfFolderWhere(shelf, organizationId), eq(projectFolders.id, folderId)))
      .limit(1)
  )
  if (!root) throw new NotFoundError('Folder not found')
  const rows = await withTenant({ organizationId }, () =>
    db
      .select({ id: projectFolders.id })
      .from(projectFolders)
      .where(
        and(
          shelfFolderWhere(shelf, organizationId),
          isNull(projectFolders.deletedAt),
          or(eq(projectFolders.id, folderId), like(projectFolders.path, `${escapeLikePattern(root.path)}/%`))
        )
      )
  )
  return rows.map((row) => row.id).filter((id) => !hidden.includes(id))
}

/** What `session` may read within `scope`. A project they may not view is a 403/404, as on the listing. */
export async function reachFor(session: AuthorizedSession, scope: SearchScope): Promise<SearchReach> {
  const base = { organizationId: session.organizationId, userId: session.userId, scope }
  if (scope.kind === 'project') {
    await requireProjectAccess(session, scope.projectId, 'project:view')
    const project = await findProjectInOrg(scope.projectId, session.organizationId)
    if (!project) throw new NotFoundError('Project not found')
    const reached = await reachProject(session, project)
    const folderIds = scope.folderId
      ? await folderSubtree(session.organizationId, projectShelf(project.id), scope.folderId, reached.hiddenFolderIds)
      : null
    return { ...base, projects: [reached], officeShelf: null, folderIds }
  }
  if (scope.kind === 'office_shelf') {
    const folderIds = scope.folderId ? await folderSubtree(session.organizationId, OFFICE_SHELF, scope.folderId, []) : null
    return { ...base, projects: [], officeShelf: await reachOfficeShelf(session), folderIds }
  }
  const [projects, officeShelf] = await Promise.all([
    listProjects(session).then((visible) => inPool(visible, PROJECTS_AT_ONCE, (project) => reachProject(session, project))),
    reachOfficeShelf(session),
  ])
  return { ...base, projects, officeShelf, folderIds: null }
}

/**
 * What a conversation's whole audience may read, as the same {@link SearchReach}
 * (ADR-0094's `audienceReach`): for the agent tier's reads from a chat, so the
 * search and the folder tree share {@link reachWhere} rather than a second rule.
 *
 * - Projects: the audience's (`audienceReach`); a scoped project outside it is
 *   not found.
 * - Restricted folders: searched only in a chat that is the asker's alone
 *   (`restrictedFolders`); otherwise every folder not every member may read is
 *   hidden and only the project's own collection is named.
 * - Held uploads: the asker's own only in their solo chat; any other audience
 *   reads screened documents only.
 * - The office shelf: every member reads it.
 */
export async function reachForAudience(
  session: AuthorizedSession,
  conversationId: string,
  scope: SearchScope,
  options: {
    includeOwnProject?: boolean
    /**
     * A listing (the agent's folder tree): restricted folders are left out even
     * in the asker's own chat, where a search may still reach them.
     */
    listing?: boolean
  } = {}
): Promise<SearchReach> {
  const audience = await withOwnProject(session, conversationId, await audienceReach(session, conversationId), options)
  const pruneRestricted = !audience.restrictedFolders || options.listing === true
  const base = {
    organizationId: session.organizationId,
    userId: session.userId,
    scope,
    screenedOnly: !audience.restrictedFolders,
  }
  const inScope =
    scope.kind === 'project'
      ? audience.projects.filter((project) => project.id === scope.projectId)
      : scope.kind === 'office'
        ? audience.projects
        : []
  if (scope.kind === 'project' && inScope.length === 0) throw new NotFoundError('Project not found')
  const projects = await inPool(inScope, PROJECTS_AT_ONCE, async (project) => {
    const reached = await reachProject(session, project)
    if (!pruneRestricted) return reached
    const restricted = await getRestrictedFolderIds(session.organizationId, project.id)
    return {
      ...reached,
      hiddenFolderIds: [...new Set([...reached.hiddenFolderIds, ...restricted])],
      collections: [project.collectionName],
      reviewsQuarantine: audience.restrictedFolders ? reached.reviewsQuarantine : false,
    }
  })
  const officeShelf = scope.kind === 'project' ? null : await reachOfficeShelf(session)
  const shelfOffice = officeShelf && !audience.restrictedFolders ? { ...officeShelf, reviewsQuarantine: false } : officeShelf
  const folderIds =
    scope.kind !== 'office' && scope.folderId
      ? await folderSubtree(
          session.organizationId,
          scope.kind === 'project' ? projectShelf(scope.projectId) : OFFICE_SHELF,
          scope.folderId,
          projects.flatMap((reached) => reached.hiddenFolderIds)
        )
      : null
  return { ...base, projects, officeShelf: scope.kind === 'project' ? null : shelfOffice, folderIds }
}

/**
 * The reach cut to `projectIds`, for every kind at once: a `projectIds` filter
 * names the projects a search may say anything about, so the folders, projects,
 * conversations and annotations it finds come from those projects alone, and
 * the office shelf drops out. A project outside the reach stays out.
 */
export function narrowReach(reach: SearchReach, projectIds: readonly string[]): SearchReach {
  const wanted = new Set(projectIds)
  return {
    ...reach,
    projects: reach.projects.filter((reached) => wanted.has(reached.project.id)),
    officeShelf: null,
    narrowedToProjects: true,
  }
}

/**
 * The audience's projects with the conversation's own project added, when
 * asked (`includeOwnProject`): `audienceReach` answers which OTHER projects a
 * lookup may search, and a shared chat's own project is not among them, while
 * a reader of the conversation reads its project (the agent's `/project/`).
 * Asked of the asker's `project:view`, as every project read is; the folder
 * pruning of the audience applies to it like to the rest.
 */
async function withOwnProject(
  session: AuthorizedSession,
  conversationId: string,
  audience: Awaited<ReturnType<typeof audienceReach>>,
  options: { includeOwnProject?: boolean }
): Promise<Awaited<ReturnType<typeof audienceReach>>> {
  if (!options.includeOwnProject) return audience
  const row = await readConversationAudience(getDb(), session.organizationId, conversationId)
  const ownId = row.projectId
  if (!ownId || audience.projects.some((project) => project.id === ownId)) return audience
  await requireProjectAccess(session, ownId, 'project:view')
  const own = await findProjectInOrg(ownId, session.organizationId)
  return own ? { ...audience, projects: [own, ...audience.projects] } : audience
}

/** The shelves a reach covers, for the projection's staleness check. */
export function reachShelves(reach: SearchReach): DocumentShelf[] {
  return [...reach.projects.map((reached) => projectShelf(reached.project.id)), ...(reach.officeShelf ? [OFFICE_SHELF] : [])]
}

/** The collections the content search may name, in the order the projects came. */
export function reachCollections(reach: SearchReach): string[] {
  return [...reach.projects.flatMap((reached) => reached.collections), ...(reach.officeShelf ? [reach.officeShelf.collection] : [])]
}

/** The reader the documents predicate takes for this reach (`documentVisibleTo`). */
export function reachReader(reach: SearchReach): DocumentReader {
  if (reach.screenedOnly) return SCREENED_ONLY
  return {
    kind: 'projects',
    userId: reach.userId,
    reviewedProjectIds: reach.projects.filter((reached) => reached.reviewsQuarantine).map((reached) => reached.project.id),
    reviewsOfficeShelf: reach.officeShelf?.reviewsQuarantine === true,
  }
}
