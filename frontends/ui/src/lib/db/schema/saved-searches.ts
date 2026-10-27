/**
 * `saved_searches` (migration 0186, ADR-0133 slice 5): a person's saved search
 * question, shareable within the office.
 *
 * A row holds the question only: `scope` is the search's query parameters and
 * `query` its body without a cursor (`lib/search/search-wire.ts`). No result is
 * stored, so a shared row carries nothing a reader could not already find:
 * running it runs as the reader, with the reader's own reach.
 */

import { sql } from 'drizzle-orm'
import { boolean, check, index, jsonb, pgTable, text, timestamp, unique, uuid } from 'drizzle-orm/pg-core'
import type { SearchBody, SearchScopeQuery } from '@/lib/search/search-wire'

export const savedSearches = pgTable(
  'saved_searches',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: text('organization_id').notNull(),
    /** The WorkOS user who saved it; only they rename, share or delete it. */
    ownerUserId: text('owner_user_id').notNull(),
    name: text('name').notNull(),
    scope: jsonb('scope').$type<SearchScopeQuery>().notNull(),
    query: jsonb('query').$type<SearchBody>().notNull(),
    /** Every member of the organization sees and runs it. */
    shared: boolean('shared').notNull().default(false),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    ownerName: unique('saved_searches_owner_name_key').on(table.organizationId, table.ownerUserId, table.name),
    nameBounded: check('saved_searches_name_bounded', sql`char_length(${table.name}) BETWEEN 1 AND 120`),
    scopeObject: check('saved_searches_scope_object', sql`jsonb_typeof(${table.scope}) = 'object'`),
    queryObject: check('saved_searches_query_object', sql`jsonb_typeof(${table.query}) = 'object'`),
    queryBounded: check('saved_searches_query_bounded', sql`octet_length(${table.query}::text) < 16000`),
    organizationSharedIdx: index('saved_searches_organization_shared_idx').on(table.organizationId, table.shared),
  })
)

export type SavedSearchRow = typeof savedSearches.$inferSelect
