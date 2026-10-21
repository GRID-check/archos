import { sql } from 'drizzle-orm'
import { boolean, index, integer, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core'
import type { KeptMove, NewFolderProposal, RootSortPlacement, RootSortRunStatus } from '@/lib/filing/root-sort-types'

/** A document the run moved, and the folder it put it in: what an undo checks before it moves it back. */
export interface RootSortMovedDocument {
  documentId: string
  folderId: string
}

/** A move the person kept that could not be applied, and why. */
export interface RootSortMoveFailure {
  documentId: string
  error: string
}

/**
 * A person's run of sorting a shelf's root into its folders (ADR-0121), worked
 * by the BFF job `root_sort`. Migration 0173 holds the bounds and says why each
 * column exists.
 */
export const rootSortRuns = pgTable(
  'root_sort_runs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: text('organization_id').notNull(),
    scope: text('scope').$type<'project' | 'office_shelf'>().notNull(),
    projectId: uuid('project_id'),
    requestedBy: text('requested_by').notNull(),
    status: text('status').$type<RootSortRunStatus>().notNull(),
    documentIds: jsonb('document_ids').$type<string[]>().notNull().default([]),
    cursor: integer('cursor').notNull().default(0),
    unreadable: integer('unreadable').notNull().default(0),
    truncated: boolean('truncated').notNull().default(false),
    placements: jsonb('placements').$type<RootSortPlacement[]>().notNull().default([]),
    failedDocumentIds: jsonb('failed_document_ids').$type<string[]>().notNull().default([]),
    newFolders: jsonb('new_folders').$type<NewFolderProposal[]>().notNull().default([]),
    keptMoves: jsonb('kept_moves').$type<KeptMove[]>().notNull().default([]),
    movedDocuments: jsonb('moved_documents').$type<RootSortMovedDocument[]>().notNull().default([]),
    moveFailures: jsonb('move_failures').$type<RootSortMoveFailure[]>().notNull().default([]),
    undoFailures: jsonb('undo_failures').$type<RootSortMoveFailure[]>().notNull().default([]),
    error: text('error'),
    jobId: uuid('job_id'),
    groupingError: text('grouping_error'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
  },
  (table) => [
    uniqueIndex('root_sort_runs_one_in_work_per_shelf')
      .on(table.organizationId, table.scope, sql`COALESCE(${table.projectId}, '00000000-0000-0000-0000-000000000000'::uuid)`)
      .where(sql`${table.status} IN ('judging', 'grouping', 'applying', 'undoing')`),
    index('root_sort_runs_shelf_recent_idx').on(table.organizationId, table.scope, table.projectId, table.createdAt.desc()),
  ]
)

export type RootSortRun = typeof rootSortRuns.$inferSelect
