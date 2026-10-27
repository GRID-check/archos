/**
 * The search's one contract (ADR-0133, docs/design/document-search.md): what a
 * person, Piloti and an outside agent ask, and what comes back. The route
 * (`POST /api/search`), the agent operation `search` and the browser parse
 * against these schemas, so the three cannot ask different questions.
 *
 * Scope is the request's query (`scope`, `projectId`, `folderId`), as on the
 * documents API (ADR-0131 rules 4 and 5); absent is the whole office. The body
 * is the question.
 *
 * No `server-only` and no drizzle: the browser imports this.
 */

import { z } from 'zod'
import { ANNOTATION_KINDS, ANNOTATION_STATUSES } from '@/lib/annotations/types'
import { DOSSIER_DOCUMENT_TYPES, DOSSIER_FACT_KEYS, DOSSIER_PARTY_ROLES } from '@/lib/documents/dossier'
import { ALLOWED_TAGS } from '@/lib/documents/tag-vocabulary'

/** What a search can find. The order is the order the sections are shown in. */
export const SEARCH_KINDS = ['document', 'annotation', 'folder', 'project', 'conversation'] as const
export type SearchKind = (typeof SEARCH_KINDS)[number]

/** The read-state families of `documentReadFamily`, as a tuple the schema can name. */
export const SEARCH_READ_STATES = ['readable', 'reading', 'failed', 'held', 'unindexed'] as const

/** The orders a document result can be read in. `relevance` needs text. */
export const SEARCH_SORTS = [
  'relevance',
  'name',
  'added',
  'plan_number',
  'plan_index',
  'plan_date',
  'document_date',
  'document_type',
  'page_count',
  'project',
] as const
export type SearchSort = (typeof SEARCH_SORTS)[number]

export const SEARCH_LIMIT_DEFAULT = 25
export const SEARCH_LIMIT_MAX = 100
/** Results of another kind shown beside the documents when several kinds are asked. */
export const SEARCH_SECTION_PREVIEW = 5
/** How deep a result can be paged: a search is for finding, the register for walking. */
export const SEARCH_OFFSET_MAX = 5000

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'YYYY-MM-DD')
const shortText = z.string().trim().min(1).max(120)

/** A fact the document states: equal to a value, or within a numeric range. */
export const factFilterSchema = z
  .object({
    key: z.enum(DOSSIER_FACT_KEYS),
    equals: shortText.optional().describe('Folded like the documents: "GK 4", "IV" and "4" match one Gebäudeklasse.'),
    min: z.number().finite().optional(),
    max: z.number().finite().optional(),
  })
  .refine((fact) => fact.equals !== undefined || fact.min !== undefined || fact.max !== undefined, {
    message: 'A fact filter needs equals, min or max',
  })
export type FactFilter = z.infer<typeof factFilterSchema>

/** A party the document names: by role, by name, or both. */
export const partyFilterSchema = z
  .object({
    role: z.enum(DOSSIER_PARTY_ROLES).optional(),
    name: shortText.optional().describe('A part of the name, any case.'),
  })
  .refine((party) => party.role !== undefined || party.name !== undefined, { message: 'A party filter needs role or name' })

const dateRange = z
  .object({ from: isoDate.optional(), to: isoDate.optional() })
  .refine((range) => range.from !== undefined || range.to !== undefined, { message: 'A date range needs from or to' })

/** What narrows the documents. Within a list any of; across fields all of. */
export const documentFiltersSchema = z.object({
  documentTypes: z.array(z.enum(DOSSIER_DOCUMENT_TYPES)).max(24).optional().describe('What the document is, as ingestion read it.'),
  tags: z
    .array(z.string().refine((tag) => ALLOWED_TAGS.has(tag), 'not a controlled tag'))
    .max(20)
    .optional()
    .describe('Controlled tags: document kind and OIB discipline.'),
  planNumber: shortText.optional().describe('The Plannummer from the title block; spaces, hyphens and case ignored, a prefix matches.'),
  planIndex: z.array(shortText).max(20).optional(),
  planDate: dateRange.optional(),
  scale: z.array(shortText).max(20).optional().describe('Maßstab as the sheet writes it, e.g. "1:100".'),
  currentOnly: z.boolean().optional().describe('Only documents no newer Fassung replaces.'),
  parties: z.array(partyFilterSchema).max(8).optional(),
  place: shortText.optional().describe('A part of the address, municipality or state.'),
  facts: z.array(factFilterSchema).max(8).optional(),
  cites: z
    .array(shortText)
    .max(8)
    .optional()
    .describe('References the document makes: a norm ("ÖNORM B 1600"), a law ("§ 33 BayBO"), a plan number ("EP-05") or a `kind:key` token.'),
  citedBy: z.string().uuid().optional().describe('Only the documents this document references by plan number or document type.'),
  citing: z.string().uuid().optional().describe('Only the documents that reference this document.'),
  documentDate: dateRange.optional(),
  uploaded: dateRange.optional(),
  photographed: dateRange.optional(),
  uploadedBy: z.array(z.string().min(1).max(100)).max(20).optional().describe('User ids of the uploaders.'),
  states: z.array(z.enum(SEARCH_READ_STATES)).max(5).optional(),
  incompleteRead: z.boolean().optional().describe('Only documents with pages that were not read.'),
  fileTypes: z
    .array(z.string().regex(/^[a-z0-9]{1,8}$/))
    .max(12)
    .optional()
    .describe('File name extensions, lower case: pdf, dwg, ifc, jpg.'),
  pages: z.object({ min: z.number().int().min(0).optional(), max: z.number().int().min(0).optional() }).optional(),
  includeArchived: z.boolean().optional(),
})
export type DocumentFilters = z.infer<typeof documentFiltersSchema>

/** What narrows the annotations. */
export const annotationFiltersSchema = z.object({
  statuses: z.array(z.enum(ANNOTATION_STATUSES)).max(4).optional().describe('Default: open and proposed.'),
  kinds: z.array(z.enum(ANNOTATION_KINDS)).max(3).optional(),
  assignedToMe: z.boolean().optional(),
  createdByMe: z.boolean().optional(),
})
export type AnnotationFilters = z.infer<typeof annotationFiltersSchema>

/** The question: `POST /api/search` body. */
export const searchBodySchema = z.object({
  text: z
    .string()
    .trim()
    .max(500)
    .optional()
    .describe('Free text: names, what the documents are and say (their content, with the page), annotations, folders, projects, conversations.'),
  kinds: z.array(z.enum(SEARCH_KINDS)).min(1).max(SEARCH_KINDS.length).optional().describe('Default: every kind.'),
  filters: documentFiltersSchema.optional(),
  annotationFilters: annotationFiltersSchema.optional(),
  sort: z.enum(SEARCH_SORTS).optional().describe('Default: relevance with text, else added.'),
  dir: z.enum(['asc', 'desc']).optional(),
  limit: z.number().int().min(1).max(SEARCH_LIMIT_MAX).optional(),
  cursor: z.string().max(200).optional().describe('The nextCursor of a previous answer with the same question and one kind.'),
  facets: z.boolean().optional().describe('Count the documents per filter value. Default true.'),
})
export type SearchBody = z.infer<typeof searchBodySchema>

/** `POST /api/search` query: where to look. */
export const searchScopeQuerySchema = z.object({
  scope: z.enum(['office', 'project', 'office_shelf']).optional().describe('Default `office`: every shelf the person may read.'),
  projectId: z.string().uuid().optional(),
  folderId: z.string().uuid().optional().describe('A folder of the project or the office shelf, its subfolders included.'),
})
export type SearchScopeQuery = z.infer<typeof searchScopeQuerySchema>

/** Where a search looks, resolved. */
export type SearchScope =
  | { kind: 'office' }
  | { kind: 'project'; projectId: string; folderId?: string }
  | { kind: 'office_shelf'; folderId?: string }

/** The passage a content match came from. */
export interface SearchPassage {
  text: string
  page: number | null
}

export interface DocumentHit {
  kind: 'document'
  id: string
  name: string
  filename: string
  shelf: 'project' | 'office_shelf'
  projectId: string | null
  projectName: string | null
  folderId: string | null
  folderName: string | null
  status: string
  contentType: string | null
  uploadedAt: string
  uploadedBy: string | null
  documentType: string | null
  title: string | null
  planNumber: string | null
  planIndex: string | null
  planDate: string | null
  scale: string | null
  documentDate: string | null
  pageCount: number | null
  pagesNotRead: number | null
  superseded: boolean
  municipality: string | null
  /** Why it matched the text: its name, what it is (the reading), its content. */
  matchedOn: Array<'name' | 'reading' | 'content'>
  passage: SearchPassage | null
}

export interface AnnotationHit {
  kind: 'annotation'
  id: string
  documentId: string
  documentName: string
  projectId: string | null
  projectName: string | null
  annotationKind: string
  status: string
  excerpt: string
  assigneeUserId: string | null
  createdAt: string
}

export interface FolderHit {
  kind: 'folder'
  id: string
  name: string
  shelf: 'project' | 'office_shelf'
  projectId: string | null
  projectName: string | null
  excerpt: string | null
}

export interface ProjectHit {
  kind: 'project'
  id: string
  name: string
  status: string
  excerpt: string | null
}

export interface ConversationHit {
  kind: 'conversation'
  id: string
  title: string
  projectId: string | null
  projectName: string | null
  updatedAt: string
}

export type SearchHit = DocumentHit | AnnotationHit | FolderHit | ProjectHit | ConversationHit

/** One kind's page of results. */
export interface SearchSection<T extends SearchHit = SearchHit> {
  hits: T[]
  /** How many there are, or a lower bound when `totalIsLowerBound` (the content search's candidate budget was reached). */
  total: number
  totalIsLowerBound: boolean
  /** Ask again with this, and `kinds` set to this section's kind alone, for the next page. */
  nextCursor: string | null
}

/** One value of a filter, with how many of the matched documents hold it. */
export interface FacetCount {
  value: string
  label: string | null
  count: number
}

export const SEARCH_FACET_DIMENSIONS = [
  'documentType',
  'tag',
  'project',
  'partyRole',
  'municipality',
  'cites',
  'state',
  'fileType',
] as const
export type SearchFacetDimension = (typeof SEARCH_FACET_DIMENSIONS)[number]

export interface SearchResponse {
  scope: SearchScope
  sections: {
    document?: SearchSection<DocumentHit>
    annotation?: SearchSection<AnnotationHit>
    folder?: SearchSection<FolderHit>
    project?: SearchSection<ProjectHit>
    conversation?: SearchSection<ConversationHit>
  }
  /** Counts over the matched documents, per filter; absent when not asked. */
  facets: Partial<Record<SearchFacetDimension, FacetCount[]>> | null
  /** Shelves whose documents are not yet filterable by what they are (the projection is being built). */
  building: string[]
  /** The content search covered only part of the scope (more collections than one search names). */
  contentPartial: boolean
}
