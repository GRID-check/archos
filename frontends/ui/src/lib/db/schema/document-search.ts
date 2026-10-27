/**
 * What a document is, made filterable beside `documents` (ADR-0136, migration
 * 0185): one derived row per document, and the sync state of each shelf.
 *
 * Derived, never authored. `lib/search/facets-projector.ts` replaces a row
 * whole from the reading ingestion stored; nothing a person writes lives here.
 *
 * `search_vector` is a generated column (`search_text` as written and folded by `grid_fold_german`, migration 0187)
 * and is deliberately not declared: nothing writes it, and the one query that
 * reads it names it in SQL (`lib/search/document-repository.ts`).
 */

import { boolean, date, integer, jsonb, pgTable, primaryKey, text, timestamp, uuid } from 'drizzle-orm/pg-core'
import { documents } from './documents'
import { projects } from './projects'

/** One party as the projection keeps it: the dossier's role and the name as the document wrote it. */
export interface SearchFacetParty {
  role: string
  name: string
}

/** One fact as the projection keeps it, for showing which page states it. */
export interface SearchFacetFact {
  key: string
  value: string
  unit: string | null
  page: number | null
}

/** One fact a new Fassung states differently from the one it replaced (the dossier's `changes`). */
export interface SearchFacetChange {
  key: string
  /** Null: newly stated. */
  before: string | null
  /** Null: no longer stated. */
  after: string | null
  page: number | null
}

export const documentSearchFacets = pgTable('document_search_facets', {
  documentId: uuid('document_id')
    .primaryKey()
    .references(() => documents.id, { onDelete: 'cascade' }),
  organizationId: text('organization_id').notNull(),
  documentType: text('document_type'),
  tags: text('tags').array().notNull().default([]),
  topics: text('topics').array().notNull().default([]),
  title: text('title'),
  summary: text('summary'),
  parties: jsonb('parties').$type<SearchFacetParty[]>().notNull().default([]),
  partyRoles: text('party_roles').array().notNull().default([]),
  address: text('address'),
  municipality: text('municipality'),
  federalState: text('federal_state'),
  facts: jsonb('facts').$type<SearchFacetFact[]>().notNull().default([]),
  /** `key=value`, lower case, values folded by `normalizeFactValue`. */
  factTokens: text('fact_tokens').array().notNull().default([]),
  /** The facts that parse as numbers, for ranges: `{ floor_area_ratio: 1.2 }`. */
  factNumbers: jsonb('fact_numbers').$type<Record<string, number>>().notNull().default({}),
  /** `kind:key`, the Qdrant payload's own `references` tokens. */
  referenceTokens: text('reference_tokens').array().notNull().default([]),
  /** The label each token was written as in the document, for display. */
  referenceLabels: jsonb('reference_labels').$type<Record<string, string>>().notNull().default({}),
  planNumber: text('plan_number'),
  /** `squashDrawingNumber(plan_number)`: what a plan reference is matched on. */
  planNumberKey: text('plan_number_key'),
  planIndex: text('plan_index'),
  planDate: date('plan_date'),
  scale: text('scale'),
  /** The document's own date: the dossier's `issued` or `plan_date`, else the Plankopf's. */
  documentDate: date('document_date'),
  capturedAt: timestamp('captured_at', { withTimezone: true }),
  camera: text('camera'),
  pageCount: integer('page_count'),
  pagesNotRead: integer('pages_not_read'),
  /** A newer Fassung replaces it. */
  superseded: boolean('superseded').notNull().default(false),
  /** What changed against the Fassung it replaced; empty when nothing did or nothing was compared. */
  changedFacts: jsonb('changed_facts').$type<SearchFacetChange[]>().notNull().default([]),
  /** The keys of {@link changedFacts}, in its order: what the filter and the facet read. */
  changedFactKeys: text('changed_fact_keys').array().notNull().default([]),
  searchText: text('search_text').notNull().default(''),
  fingerprint: text('fingerprint').notNull(),
  syncedAt: timestamp('synced_at', { withTimezone: true }).notNull().defaultNow(),
})

export type DocumentSearchFacetsRow = typeof documentSearchFacets.$inferSelect
export type NewDocumentSearchFacetsRow = typeof documentSearchFacets.$inferInsert

/** The sync state of one shelf: `project:<id>` or `office_shelf`. */
export const documentSearchShelves = pgTable(
  'document_search_shelves',
  {
    organizationId: text('organization_id').notNull(),
    shelfKey: text('shelf_key').notNull(),
    projectId: uuid('project_id').references(() => projects.id, { onDelete: 'cascade' }),
    /** The shelf's documents when last refreshed (`shelfSourceFingerprint`). */
    sourceFingerprint: text('source_fingerprint'),
    syncedAt: timestamp('synced_at', { withTimezone: true }),
    /** When a refresh was last queued; at most one per interval. */
    refreshRequestedAt: timestamp('refresh_requested_at', { withTimezone: true }),
  },
  (table) => ({ pk: primaryKey({ columns: [table.organizationId, table.shelfKey] }) })
)

export type DocumentSearchShelfRow = typeof documentSearchShelves.$inferSelect
