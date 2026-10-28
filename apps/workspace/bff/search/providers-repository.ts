/**
 * The SQL of the search's other kinds (ADR-0136, docs/design/document-search.md
 * "What everything covers"): annotations, folders and conversations, each under
 * the reach the documents are searched with.
 *
 * - An annotation is found only on a document the documents' own predicate
 *   lets through (`documentSearchWhere`): the reach (the shelves, the hidden
 *   folders, the hold) and the search's document filters, so a chip such as
 *   „Dokumentart: Einreichplan“ narrows the annotations as it narrows the
 *   documents. One rule, one join: never a second reading of the filters.
 * - A folder is found when it is alive, on a shelf in reach, not hidden from
 *   the reader, and inside the folder scope when there is one.
 * - A conversation follows the conversation list's own rule
 *   (`visibleConversationsWhere`), over every project in reach at once.
 *
 * Every page is bounded, and every total is a count over at most
 * {@link SEARCH_TOTAL_CAP} rows.
 */

import 'server-only'
import { and, asc, desc, eq, inArray, isNull, notInArray, or, sql, type SQL } from 'drizzle-orm'
import { getDb } from '@/lib/db'
import { conversations } from '@/lib/db/schema/conversations'
import { documentAnnotationReplies, documentAnnotations } from '@/lib/db/schema/document-annotations'
import { documentSearchFacets } from '@/lib/db/schema/document-search'
import { documents } from '@/lib/db/schema/documents'
import { projectFolders } from '@/lib/db/schema/project-folders'
import { projects } from '@/lib/db/schema/projects'
import { withTenant } from '@/lib/db/tenant-context'
import { visibleConversationsWhere } from '@/lib/conversations/repository'
import { likeContains } from '@/lib/text/like-pattern'
import type { AnnotationKind, AnnotationStatus } from '@/lib/annotations/types'
import { documentSearchWhere, type DocumentQuery } from './document-repository'
import type { SearchReach } from './reach'
import { SEARCH_LIMIT_MAX } from './search-wire'

/** The most rows a total counts; a section with more says this many. */
export const SEARCH_TOTAL_CAP = 1000

export interface ProviderPage {
  limit: number
  offset: number
}

const bounded = (page: ProviderPage) => ({
  limit: Math.min(Math.max(1, Math.trunc(page.limit)), SEARCH_LIMIT_MAX),
  offset: Math.max(0, Math.trunc(page.offset)),
})

// --- Annotations ------------------------------------------------------------

export interface AnnotationQuery {
  /** Matched against the body and every reply; null lists by the filters alone. */
  text: string | null
  statuses: readonly AnnotationStatus[]
  kinds: readonly AnnotationKind[] | null
  assigneeUserId: string | null
  createdBy: string | null
  /** What the annotation's document must be: the documents' question without its text. */
  documents: Omit<DocumentQuery, 'text'>
}

export interface AnnotationSearchRow {
  id: string
  documentId: string
  filename: string
  displayName: string | null
  projectId: string | null
  projectName: string | null
  kind: string
  status: string
  body: string
  /** The first reply that carries the text, when the body does not. */
  matchedReply: string | null
  assigneeUserId: string | null
  createdAt: Date
}

/**
 * Whether a reply of the outer annotation row carries the text, and the first
 * one that does. Correlated to `document_annotations.id` of the query it sits
 * in, which joins `documents` under the reach.
 */
function replyMatch(organizationId: string, text: string) {
  const db = getDb()
  const matching = and(
    eq(documentAnnotationReplies.organizationId, organizationId),
    eq(documentAnnotationReplies.annotationId, documentAnnotations.id),
    sql`${documentAnnotationReplies.body} ILIKE ${likeContains(text)}`
  )
  return {
    any: sql`EXISTS (${db
      .select({ one: sql`1` })
      .from(documentAnnotationReplies)
      .where(matching)})`,
    first: sql<string | null>`(${db
      .select({ body: documentAnnotationReplies.body })
      .from(documentAnnotationReplies)
      .where(matching)
      .orderBy(asc(documentAnnotationReplies.createdAt))
      .limit(1)})`,
  }
}

function annotationWhere(reach: SearchReach, query: AnnotationQuery): SQL | undefined {
  return and(
    eq(documentAnnotations.organizationId, reach.organizationId),
    documentSearchWhere(reach, { ...query.documents, text: null }),
    inArray(documentAnnotations.status, [...query.statuses]),
    query.kinds?.length ? inArray(documentAnnotations.kind, [...query.kinds]) : undefined,
    query.assigneeUserId ? eq(documentAnnotations.assigneeUserId, query.assigneeUserId) : undefined,
    query.createdBy ? eq(documentAnnotations.createdBy, query.createdBy) : undefined,
    query.text
      ? or(
          sql`${documentAnnotations.body} ILIKE ${likeContains(query.text)}`,
          replyMatch(reach.organizationId, query.text).any
        )
      : undefined
  )
}

/** One page of the annotations a search finds, newest first, and how many there are (at most {@link SEARCH_TOTAL_CAP}). */
export async function searchAnnotationRows(
  reach: SearchReach,
  query: AnnotationQuery,
  page: ProviderPage
): Promise<{ rows: AnnotationSearchRow[]; total: number }> {
  const { limit, offset } = bounded(page)
  if (query.statuses.length === 0) return { rows: [], total: 0 }
  const db = getDb()
  const where = annotationWhere(reach, query)
  const capped = db
    .select({ one: sql`1` })
    .from(documentAnnotations)
    .innerJoin(documents, eq(documents.id, documentAnnotations.documentId))
    .leftJoin(documentSearchFacets, eq(documentSearchFacets.documentId, documents.id))
    .where(where)
    .limit(SEARCH_TOTAL_CAP)
    .as('capped')
  const [rows, [{ total }]] = await withTenant({ organizationId: reach.organizationId }, () =>
    Promise.all([
      db
        .select({
          id: documentAnnotations.id,
          documentId: documentAnnotations.documentId,
          filename: documents.filename,
          displayName: documents.displayName,
          projectId: documents.projectId,
          projectName: projects.name,
          kind: documentAnnotations.kind,
          status: documentAnnotations.status,
          body: documentAnnotations.body,
          matchedReply: query.text
            ? replyMatch(reach.organizationId, query.text).first
            : sql<string | null>`null`,
          assigneeUserId: documentAnnotations.assigneeUserId,
          createdAt: documentAnnotations.createdAt,
        })
        .from(documentAnnotations)
        .innerJoin(documents, eq(documents.id, documentAnnotations.documentId))
        .leftJoin(documentSearchFacets, eq(documentSearchFacets.documentId, documents.id))
        .leftJoin(projects, eq(projects.id, documents.projectId))
        .where(where)
        .orderBy(desc(documentAnnotations.createdAt), asc(documentAnnotations.id))
        .limit(limit)
        .offset(offset),
      db.select({ total: sql<number>`count(*)` }).from(capped),
    ])
  )
  return {
    rows: rows.map((row) => ({
      ...row,
      matchedReply: row.matchedReply === null ? null : String(row.matchedReply),
      createdAt: new Date(row.createdAt),
    })),
    total: Number(total),
  }
}

// --- Folders ----------------------------------------------------------------

export interface FolderSearchRow {
  id: string
  name: string
  description: string | null
  scope: 'project' | 'office_shelf'
  projectId: string | null
  projectName: string | null
}

/** The folders in reach: alive, on a shelf in reach, not hidden, inside the folder scope. */
export function folderReachWhere(reach: SearchReach): SQL {
  const projectIds = reach.projects.map((reached) => reached.project.id)
  const hidden = reach.projects.flatMap((reached) => reached.hiddenFolderIds)
  const shelves = or(
    projectIds.length > 0
      ? and(eq(projectFolders.scope, 'project'), inArray(projectFolders.projectId, projectIds))
      : undefined,
    reach.officeShelf ? eq(projectFolders.scope, 'office_shelf') : undefined
  )
  return and(
    eq(projectFolders.organizationId, reach.organizationId),
    isNull(projectFolders.deletedAt),
    shelves ?? sql`false`,
    hidden.length > 0 ? notInArray(projectFolders.id, hidden) : undefined,
    reach.folderIds
      ? reach.folderIds.length > 0
        ? inArray(projectFolders.id, [...reach.folderIds])
        : sql`false`
      : undefined
  ) as SQL
}

/** One page of the folders whose name or description carries the text, by name, and how many there are. */
export async function searchFolderRows(
  reach: SearchReach,
  text: string,
  page: ProviderPage
): Promise<{ rows: FolderSearchRow[]; total: number }> {
  const { limit, offset } = bounded(page)
  const db = getDb()
  const pattern = likeContains(text)
  const where = and(
    folderReachWhere(reach),
    or(
      sql`${projectFolders.name} ILIKE ${pattern}`,
      sql`${projectFolders.description} ILIKE ${pattern}`
    )
  )
  const capped = db
    .select({ one: sql`1` })
    .from(projectFolders)
    .where(where)
    .limit(SEARCH_TOTAL_CAP)
    .as('capped')
  const [rows, [{ total }]] = await withTenant({ organizationId: reach.organizationId }, () =>
    Promise.all([
      db
        .select({
          id: projectFolders.id,
          name: projectFolders.name,
          description: projectFolders.description,
          scope: projectFolders.scope,
          projectId: projectFolders.projectId,
          projectName: projects.name,
        })
        .from(projectFolders)
        .leftJoin(projects, eq(projects.id, projectFolders.projectId))
        .where(where)
        .orderBy(asc(sql`lower(${projectFolders.name})`), asc(projectFolders.id))
        .limit(limit)
        .offset(offset),
      db.select({ total: sql<number>`count(*)` }).from(capped),
    ])
  )
  return {
    rows: rows.map((row) => ({
      ...row,
      scope: row.scope === 'office_shelf' ? 'office_shelf' : 'project',
    })),
    total: Number(total),
  }
}

// --- Conversations ----------------------------------------------------------

/** Where a conversation search looks: the projects in reach, and whether rows without a project count. */
export interface ConversationReach {
  projectIds: readonly string[]
  withoutContainer: boolean
}

export interface ConversationSearchRow {
  id: string
  projectId: string | null
  title: string | null
  updatedAt: Date
}

/**
 * The conversations the caller may see whose title carries the text or whose
 * topic tags include one of `tagKeys`, newest first, at most
 * {@link SEARCH_TOTAL_CAP}. Withheld content (ADR-0088) is judged by the caller
 * of this, over these rows, before any of them is reported.
 */
export async function searchConversationRows(
  organizationId: string,
  userId: string,
  where: ConversationReach,
  text: string,
  tagKeys: readonly string[]
): Promise<ConversationSearchRow[]> {
  if (where.projectIds.length === 0 && !where.withoutContainer) return []
  const rows = await withTenant({ organizationId }, () =>
    getDb()
      .select({
        id: conversations.id,
        projectId: conversations.projectId,
        title: conversations.title,
        updatedAt: conversations.updatedAt,
      })
      .from(conversations)
      .where(
        and(
          visibleConversationsWhere(organizationId, userId, where),
          isNull(conversations.deletedAt),
          or(
            sql`${conversations.title} ILIKE ${likeContains(text)}`,
            tagKeys.length > 0
              ? sql`${conversations.tags} && ARRAY[${sql.join(
                  tagKeys.map((key) => sql`${key}`),
                  sql`, `
                )}]::text[]`
              : undefined
          )
        )
      )
      .orderBy(desc(conversations.updatedAt), desc(conversations.id))
      .limit(SEARCH_TOTAL_CAP)
  )
  return rows.map((row) => ({ ...row, updatedAt: new Date(row.updatedAt) }))
}
