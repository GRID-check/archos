import { sql } from 'drizzle-orm'
import { check, foreignKey, index, jsonb, pgTable, text, timestamp, unique, uuid } from 'drizzle-orm/pg-core'
import type { FolderCardKeyFact } from '@/lib/folder-cards/types'
import { projectFolders } from './project-folders'

/**
 * The tier-1 card of a folder: an abstract and up to eight key facts (ADR-0127,
 * migration 0180). One row per folder, written only through the BFF's
 * `PUT /api/internal/folder-cards`; the Python builder computes it, and the
 * Qdrant folder point derived from it is rebuildable.
 *
 * `collection` is the retrieval collection the card's documents live in. A
 * restricted folder is its own collection, so its card lives in that scope and
 * a parent card never reads it (ADR-0088).
 */
export const folderCards = pgTable(
  'folder_cards',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: text('organization_id').notNull(),
    folderId: uuid('folder_id').notNull(),
    /** The folder's shelf, held equal to the folder's own by the composite key. */
    scope: text('scope', { enum: ['project', 'office_shelf'] }).notNull(),
    collection: text('collection').notNull(),
    abstract: text('abstract'),
    keyFacts: jsonb('key_facts').$type<FolderCardKeyFact[]>().notNull().default(sql`'[]'::jsonb`),
    /** Hash of what the card was built from; unchanged means nothing is rebuilt. */
    inputHash: text('input_hash').notNull(),
    /** Hash of the abstract, so an abstract that comes out the same does not rewrite the folder point. */
    abstractHash: text('abstract_hash'),
    model: text('model'),
    promptVersion: text('prompt_version'),
    status: text('status', { enum: ['fresh', 'stale', 'failed'] }).notNull().default('stale'),
    generatedAt: timestamp('generated_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    folderKey: unique('folder_cards_folder_key').on(table.folderId),
    folderFk: foreignKey({
      name: 'folder_cards_folder_fkey',
      columns: [table.folderId, table.organizationId, table.scope],
      foreignColumns: [projectFolders.id, projectFolders.organizationId, projectFolders.scope],
    }).onDelete('cascade'),
    collectionIdx: index('idx_folder_cards_collection').on(table.organizationId, table.collection),
    scopeCheck: check('folder_cards_scope_check', sql`${table.scope} IN ('project', 'office_shelf')`),
    abstractLength: check(
      'folder_cards_abstract_length',
      sql`${table.abstract} IS NULL OR char_length(${table.abstract}) <= 600`,
    ),
    keyFactsShape: check(
      'folder_cards_key_facts_shape',
      sql`jsonb_typeof(${table.keyFacts}) = 'array' AND jsonb_array_length(${table.keyFacts}) <= 8`,
    ),
    statusCheck: check('folder_cards_status_check', sql`${table.status} IN ('fresh', 'stale', 'failed')`),
  }),
)

export type FolderCardRow = typeof folderCards.$inferSelect
