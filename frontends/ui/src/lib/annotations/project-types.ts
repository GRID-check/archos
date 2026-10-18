/**
 * A project's Offene Punkte as data: the open Anmerkungen of every document of
 * one project, the list a Jour fixe is run from (`GET
 * /api/projects/{id}/annotations`), and its Protokoll (`…/annotations/export`).
 *
 * A Jour fixe is held per project, not per document. The Prüfansicht answers
 * „what is open on this sheet"; this answers „what is open in the project",
 * each row the same {@link annotationViewSchema} a document's list carries,
 * with the name of the document it sits on.
 *
 * No `server-only` and no drizzle: the browser, the typed client, the routes
 * and the specs share these, so the page, the link and the parser cannot
 * disagree about a filter (ADR-0055).
 */

import { z } from 'zod'
import { ANNOTATION_EXPORT_FORMATS, type AnnotationExportFormat } from './export-request'
import { annotationViewSchema } from './types'

/**
 * Which marks: `open` (the default; the office's own open marks), `proposed`
 * (Piloti's proposals nobody decided on), `all-live` (both, `isLive`).
 */
export const PROJECT_MARK_STATUSES = ['open', 'proposed', 'all-live'] as const
export type ProjectMarkStatus = (typeof PROJECT_MARK_STATUSES)[number]

/**
 * The Frist: `overdue`, a date before today; `soon`, from today through
 * {@link DUE_SOON_DAYS} days ahead, the week to the next Jour fixe. Both on the
 * office's calendar (`OFFICE_TIME_ZONE`), as the daily reminder counts.
 */
export const PROJECT_MARK_DUE = ['overdue', 'soon'] as const
export type ProjectMarkDue = (typeof PROJECT_MARK_DUE)[number]

/** How far ahead „bald" looks, in calendar days after today. */
export const DUE_SOON_DAYS = 7

/**
 * The order of the page: `document` (by the document's name, then the mark's
 * number, so a page groups by document), or `due` (the earliest Frist first,
 * marks without one last, then as `document`).
 */
export const PROJECT_MARK_ORDERS = ['document', 'due'] as const
export type ProjectMarkOrder = (typeof PROJECT_MARK_ORDERS)[number]

/** A page's size when the request names none, and the most one page holds. */
export const PROJECT_MARKS_PAGE_SIZE = 50
export const MAX_PROJECT_MARKS_PAGE = 100

/** The longest `assignee` a request may name: `me`, or a user id. */
const MAX_ASSIGNEE_ID = 200

/** The longest cursor the route accepts; the service writes well under it (a name is at most 200 characters). */
export const PROJECT_MARKS_CURSOR_MAX_LENGTH = 1200

/** `assignee=me`: the reader. Anything else is a user id. */
export const ASSIGNEE_ME = 'me'

/** The filters, as the list and the Protokoll both take them. */
const filterShape = {
  status: z.enum(PROJECT_MARK_STATUSES).default('open'),
  assignee: z.string().trim().min(1).max(MAX_ASSIGNEE_ID).optional(),
  due: z.enum(PROJECT_MARK_DUE).optional(),
  order: z.enum(PROJECT_MARK_ORDERS).default('document'),
}

/** `GET /api/projects/{id}/annotations`: the filters, and the page. */
export const projectMarksQuerySchema = z.object({
  ...filterShape,
  limit: z.coerce.number().int().min(1).max(MAX_PROJECT_MARKS_PAGE).default(PROJECT_MARKS_PAGE_SIZE),
  cursor: z.string().min(1).max(PROJECT_MARKS_CURSOR_MAX_LENGTH).optional(),
})
export type ProjectMarksQuery = z.output<typeof projectMarksQuerySchema>

/** What the page asks for: the filters, every one optional. */
export type ProjectMarksFilters = Partial<Pick<ProjectMarksQuery, 'status' | 'assignee' | 'due' | 'order'>>

/** One row: a mark as a document's own list shows it, and the name of the document it sits on. */
export const projectMarkViewSchema = annotationViewSchema.extend({
  /** The document's name as a person sees it (`documentDisplayName`). */
  documentName: z.string(),
})
export type ProjectMarkView = z.infer<typeof projectMarkViewSchema>

export const projectMarksResponseSchema = z.object({
  marks: z.array(projectMarkViewSchema),
  /** Where the next page starts; null on the last one. */
  nextCursor: z.string().nullable(),
})
export type ProjectMarksResponse = z.infer<typeof projectMarksResponseSchema>

/** `GET /api/projects/{id}/annotations/export`: the list's filters, and the format. PDF by default. */
export const projectProtocolQuerySchema = z.object({
  ...filterShape,
  format: z.enum(ANNOTATION_EXPORT_FORMATS).default('pdf'),
})
export type ProjectProtocolQuery = z.output<typeof projectProtocolQuerySchema>

/** The most marks one project Protokoll carries; past it the export is refused, never cut. */
export const PROJECT_PROTOCOL_MAX_MARKS = 1000

const projectPath = (projectId: string) => `/api/projects/${encodeURIComponent(projectId)}/annotations`

/** The filters as query parameters, leaving out what is the default, so a link reads as what it asks. */
function filterParams(filters: ProjectMarksFilters): URLSearchParams {
  const query = new URLSearchParams()
  if (filters.status && filters.status !== 'open') query.set('status', filters.status)
  if (filters.assignee) query.set('assignee', filters.assignee)
  if (filters.due) query.set('due', filters.due)
  if (filters.order && filters.order !== 'document') query.set('order', filters.order)
  return query
}

const withQuery = (path: string, query: URLSearchParams) => {
  const text = query.toString()
  return text ? `${path}?${text}` : path
}

/** The list's URL: the filters, a page size, and where to start. */
export function projectMarksHref(
  projectId: string,
  filters: ProjectMarksFilters = {},
  page: { limit?: number; cursor?: string | null } = {}
): string {
  const query = filterParams(filters)
  if (page.limit !== undefined) query.set('limit', String(page.limit))
  if (page.cursor) query.set('cursor', page.cursor)
  return withQuery(projectPath(projectId), query)
}

/** The Protokoll's download link: the same filters as the list on screen. A GET, so the browser's own download handles it. */
export function projectProtocolHref(
  projectId: string,
  filters: ProjectMarksFilters,
  format: AnnotationExportFormat
): string {
  const query = filterParams(filters)
  query.set('format', format)
  return withQuery(`${projectPath(projectId)}/export`, query)
}
