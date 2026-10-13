import { sql } from 'drizzle-orm'
import { check, foreignKey, index, jsonb, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core'
import {
  PILOTI_CHANGE_OBJECTS,
  PILOTI_CHANGE_OPS,
  type ChangeState,
  type PilotiChangeObject,
  type PilotiChangeOp,
} from '@/lib/changes/types'
import { conversations } from './conversations'
import { documents } from './documents'

const list = (values: readonly string[]) => sql.raw(values.map((value) => `'${value}'`).join(', '))

/**
 * `piloti_changes` — every change Piloti applied to an Anmerkung or a thread,
 * with the turn that made it (migration 0142, ADR-0109;
 * `docs/architecture/document-annotations.md`).
 *
 * `annotation_id` has no foreign key on purpose: a `delete` outlives the mark
 * it deleted, or it could never be undone. The record goes with its document
 * and with the conversation of the turn that made it.
 */
export const pilotiChanges = pgTable(
  'piloti_changes',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: text('organization_id').notNull(),
    documentId: uuid('document_id').notNull(),
    annotationId: uuid('annotation_id').notNull(),
    objectKind: text('object_kind').$type<PilotiChangeObject>().notNull(),
    objectId: uuid('object_id').notNull(),
    op: text('op').$type<PilotiChangeOp>().notNull(),
    before: jsonb('before').$type<ChangeState>(),
    after: jsonb('after').$type<ChangeState>(),
    originConversationId: text('origin_conversation_id').notNull(),
    /** The answer message of the turn that made the change. */
    originMessageId: uuid('origin_message_id').notNull(),
    /** The person the turn acted for. */
    onBehalfOf: text('on_behalf_of').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    undoneAt: timestamp('undone_at', { withTimezone: true }),
    undoneBy: text('undone_by'),
  },
  (table) => ({
    documentFk: foreignKey({
      name: 'piloti_changes_document_fkey',
      columns: [table.documentId],
      foreignColumns: [documents.id],
    }).onDelete('cascade'),
    conversationFk: foreignKey({
      name: 'piloti_changes_conversation_fkey',
      columns: [table.originConversationId, table.organizationId],
      foreignColumns: [conversations.id, conversations.organizationId],
    }).onDelete('cascade'),
    originIdx: index('idx_piloti_changes_origin').on(table.organizationId, table.originMessageId, table.createdAt),
    annotationIdx: index('idx_piloti_changes_annotation').on(table.annotationId, table.createdAt),
    objectKnown: check('piloti_changes_object_known', sql`${table.objectKind} IN (${list(PILOTI_CHANGE_OBJECTS)})`),
    opKnown: check('piloti_changes_op_known', sql`${table.op} IN (${list(PILOTI_CHANGE_OPS)})`),
    replyIsCreated: check(
      'piloti_changes_reply_is_created',
      sql`${table.objectKind} <> 'annotation_reply' OR ${table.op} = 'create'`
    ),
    annotationIsObject: check(
      'piloti_changes_annotation_is_object',
      sql`${table.objectKind} <> 'annotation' OR ${table.objectId} = ${table.annotationId}`
    ),
    statesByOp: check(
      'piloti_changes_states_by_op',
      sql`(${table.op} = 'create' AND ${table.before} IS NULL AND ${table.after} IS NOT NULL) OR (${table.op} = 'update' AND ${table.before} IS NOT NULL AND ${table.after} IS NOT NULL) OR (${table.op} = 'delete' AND ${table.before} IS NOT NULL AND ${table.after} IS NULL)`
    ),
    statesAreObjects: check(
      'piloti_changes_states_are_objects',
      sql`(${table.before} IS NULL OR jsonb_typeof(${table.before}) = 'object') AND (${table.after} IS NULL OR jsonb_typeof(${table.after}) = 'object')`
    ),
    undoComplete: check(
      'piloti_changes_undo_complete',
      sql`(${table.undoneAt} IS NULL) = (${table.undoneBy} IS NULL)`
    ),
  })
)

export type PilotiChangeRow = typeof pilotiChanges.$inferSelect
export type NewPilotiChangeRow = typeof pilotiChanges.$inferInsert
