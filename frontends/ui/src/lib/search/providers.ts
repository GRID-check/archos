/**
 * The search's providers beside the documents (ADR-0136, docs/design/
 * document-search.md "What everything covers"): annotations, folders, projects
 * and conversations. Each takes the reach the search computed once and asks no
 * gate of its own, so the kinds cannot disagree about what a person may read.
 *
 * | Kind         | Matched on                   | Who sees it |
 * |--------------|------------------------------|-------------|
 * | annotation   | body and replies             | annotations on documents the documents' predicate lets through: the reach and the document filters |
 * | folder       | name, description            | living folders on a shelf in reach, not hidden from the reader |
 * | project      | name, site address           | the projects in reach |
 * | conversation | title, topic tags            | the conversation list's own rule over the projects in reach, minus withheld content |
 *
 * Folders, projects and conversations carry nothing a document filter asks
 * about, so the search sets them aside while one is set (`setAsideKinds` in
 * `./search-wire.ts`) rather than list rows the filter never touched.
 *
 * Message bodies are not searched: a message can quote a restricted folder the
 * reader is not cleared for, which needs its own provider and test.
 */

import 'server-only'
import type { AuthorizedSession } from '@/lib/auth/types'
import { LIVE_ANNOTATION_STATUSES } from '@/lib/annotations/types'
import { lockedConversationIds } from '@/lib/conversations/restricted-use'
import { CONVERSATION_TAG_KEYS, LEGACY_CONVERSATION_TAG_KEYS } from '@/lib/conversations/tags'
import { withTenant } from '@/lib/db/tenant-context'
import { documentDisplayName } from '@/lib/documents/display-name'
import { dictionaries } from '@/i18n/dictionaries'
import { excerptAround } from '@/lib/text/excerpt'
import {
  searchAnnotationRows,
  searchConversationRows,
  searchFolderRows,
  SEARCH_TOTAL_CAP,
  type ConversationReach,
  type ProviderPage,
} from './providers-repository'
import type { DocumentQuery } from './document-repository'
import type { ReachedProject, SearchReach } from './reach'
import {
  SEARCH_LIMIT_MAX,
  type AnnotationFilters,
  type AnnotationHit,
  type ConversationHit,
  type FolderHit,
  type ProjectHit,
} from './search-wire'

/** The longest excerpt a hit carries. */
export const EXCERPT_MAX = 200

interface Found<T> {
  hits: T[]
  total: number
}

const pageOf = (page: ProviderPage) => ({
  limit: Math.min(Math.max(1, Math.trunc(page.limit)), SEARCH_LIMIT_MAX),
  offset: Math.max(0, Math.trunc(page.offset)),
})

const fold = (value: string) => value.normalize('NFC').toLocaleLowerCase().trim()

/**
 * The annotations whose body or a reply carries `text` (or every one, by the
 * filters, without text), on documents `documents` admits: the reach and the
 * document filters, as the documents section reads them.
 */
export async function searchAnnotations(
  reach: SearchReach,
  text: string | null,
  filters: AnnotationFilters,
  documents: Omit<DocumentQuery, 'text'>,
  page: ProviderPage
): Promise<Found<AnnotationHit>> {
  const term = text?.trim() ? text.trim() : null
  const { rows, total } = await searchAnnotationRows(
    reach,
    {
      text: term,
      statuses: filters.statuses?.length ? filters.statuses : LIVE_ANNOTATION_STATUSES,
      kinds: filters.kinds?.length ? filters.kinds : null,
      assigneeUserId: filters.assignedToMe ? reach.userId : null,
      createdBy: filters.createdByMe ? reach.userId : null,
      documents,
    },
    pageOf(page)
  )
  const hits = rows.map((row): AnnotationHit => {
    const inBody = term === null || fold(row.body).includes(fold(term))
    return {
      kind: 'annotation',
      id: row.id,
      documentId: row.documentId,
      documentName: documentDisplayName(row),
      shelf: row.projectId === null ? 'office_shelf' : 'project',
      projectId: row.projectId,
      projectName: row.projectName,
      annotationKind: row.kind,
      status: row.status,
      excerpt: excerptAround(
        inBody || row.matchedReply === null ? row.body : row.matchedReply,
        term,
        EXCERPT_MAX
      ),
      assigneeUserId: row.assigneeUserId,
      createdAt: row.createdAt.toISOString(),
    }
  })
  return { hits, total }
}

/** The folders in reach whose name or description carries `text`. */
export async function searchFolders(
  reach: SearchReach,
  text: string,
  page: ProviderPage
): Promise<Found<FolderHit>> {
  const term = text.trim()
  if (!term) return { hits: [], total: 0 }
  const { rows, total } = await searchFolderRows(reach, term, pageOf(page))
  const hits = rows.map((row): FolderHit => ({
    kind: 'folder',
    id: row.id,
    name: row.name,
    shelf: row.scope,
    projectId: row.projectId,
    projectName: row.projectName,
    excerpt: row.description ? excerptAround(row.description, term, EXCERPT_MAX) : null,
  }))
  return { hits, total }
}

/** The site address on a project's profile, as stored. */
export function projectAddress(project: ReachedProject['project']): string | null {
  const value = project.profile?.facts?.site_address?.value
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

/**
 * The projects in reach whose name or site address carries `text`: in memory,
 * since the reach already holds every project row. A name match first, then
 * by name. Pure.
 */
export function searchProjects(
  reach: SearchReach,
  text: string,
  page: ProviderPage
): Found<ProjectHit> {
  const term = fold(text)
  if (!term) return { hits: [], total: 0 }
  const matched = reach.projects
    .map(({ project }) => ({ project, address: projectAddress(project) }))
    .map((entry) => ({ ...entry, byName: fold(entry.project.name).includes(term) }))
    .filter(
      (entry) => entry.byName || (entry.address !== null && fold(entry.address).includes(term))
    )
    .sort(
      (a, b) =>
        Number(b.byName) - Number(a.byName) ||
        a.project.name.localeCompare(b.project.name, 'de') ||
        a.project.id.localeCompare(b.project.id)
    )
  const { limit, offset } = pageOf(page)
  const hits = matched.slice(offset, offset + limit).map(({ project, address }): ProjectHit => ({
    kind: 'project',
    id: project.id,
    name: project.name,
    status: project.status,
    excerpt: address,
  }))
  return { hits, total: Math.min(matched.length, SEARCH_TOTAL_CAP) }
}

/**
 * The topic tag keys a text names: the key itself, a legacy key, or the label
 * a person reads in either language ("Brandschutz", "fire safety"). Pure.
 */
export function conversationTagsNamedBy(text: string): string[] {
  const term = fold(text)
  if (term.length < 3) return []
  const labelsOf = (key: string): string[] => [
    key,
    key.replaceAll('_', ' '),
    ...Object.entries(LEGACY_CONVERSATION_TAG_KEYS)
      .filter(([, current]) => current === key)
      .map(([legacy]) => legacy),
    ...Object.values(dictionaries).map(
      (dictionary) =>
        (dictionary.platform.answerFeedback.topics as Record<string, string>)[key] ?? key
    ),
  ]
  return CONVERSATION_TAG_KEYS.filter((key) =>
    labelsOf(key).some((label) => fold(label).includes(term))
  )
}

/**
 * Where a conversation search looks for a scope. The whole office: every
 * project in reach and the rows with no project, judged as the list judges
 * them. A project: that project's rows only. A folder or the office shelf: no
 * conversation lives there.
 */
export function conversationReachOf(reach: SearchReach): ConversationReach {
  if (reach.narrowedToProjects) {
    return { projectIds: reach.projects.map((reached) => reached.project.id), withoutContainer: false }
  }
  if (reach.scope.kind === 'office') {
    return {
      projectIds: reach.projects.map((reached) => reached.project.id),
      withoutContainer: true,
    }
  }
  if (reach.scope.kind === 'project' && !reach.scope.folderId) {
    return { projectIds: [reach.scope.projectId], withoutContainer: false }
  }
  return { projectIds: [], withoutContainer: false }
}

/**
 * The conversations the caller may see whose title or topic tags carry `text`.
 * A conversation whose content is withheld from the caller (ADR-0088) is
 * dropped before anything is reported: its title and tags were written from
 * that content, so a match on them would name it.
 */
export async function searchConversations(
  session: AuthorizedSession,
  reach: SearchReach,
  text: string,
  page: ProviderPage
): Promise<Found<ConversationHit>> {
  const term = text.trim()
  if (!term) return { hits: [], total: 0 }
  const candidates = await searchConversationRows(
    reach.organizationId,
    reach.userId,
    conversationReachOf(reach),
    term,
    conversationTagsNamedBy(term)
  )
  if (candidates.length === 0) return { hits: [], total: 0 }
  const locked = await withTenant(
    { organizationId: reach.organizationId, userId: reach.userId },
    () =>
      lockedConversationIds(
        session,
        candidates.map((row) => ({ id: row.id, projectId: row.projectId }))
      )
  )
  const readable = candidates.filter((row) => !locked.has(row.id))
  const names = new Map(reach.projects.map((reached) => [reached.project.id, reached.project.name]))
  const { limit, offset } = pageOf(page)
  const hits = readable.slice(offset, offset + limit).map((row): ConversationHit => ({
    kind: 'conversation',
    id: row.id,
    title: row.title ?? '',
    projectId: row.projectId,
    projectName: row.projectId ? (names.get(row.projectId) ?? null) : null,
    updatedAt: row.updatedAt.toISOString(),
  }))
  return { hits, total: readable.length }
}
