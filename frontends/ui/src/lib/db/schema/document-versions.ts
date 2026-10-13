/**
 * `document_versions` — the editorial state of a document's bytes (ADR-0054).
 *
 * The item stays `documents`: its id is what citations, subjects, assignments,
 * shares and folders reference, and what the idempotency index on
 * `(organization, project, authored_by_ref, authored_by_producer)` is keyed on.
 * A version is one set of bytes for that item, plus the one fact the item could
 * never carry — **whether the office asserts it**.
 *
 * A row per version rather than a row per document, because every relation in
 * the product binds the item id and a second `documents` row per revision would
 * break all of them at once: the idempotency index forbids it, the folder tree
 * would show a revision as a sibling file, and each row is an object plus a
 * quota charge.
 *
 * ## One history for humans and for Piloti
 *
 * This is NOT an agent-only structure. Re-uploading a file under a name that
 * already exists has replaced the document in place since migration 0074 —
 * same id, so citations, subjects and folder assignments survive — and threw
 * the old bytes away. That was versioning without the history. A human upload
 * now writes version 1 `published`, with no review because the person who
 * uploaded it is the assertion (`origin = 'upload'`, migration 0137); a re-upload writes version N+1 and leaves N
 * standing as `superseded` with its bytes intact; an agent filing writes a
 * `draft`. One pointer, one badge vocabulary, one version list.
 *
 * ## What the CHECKs are for
 *
 * They are the ratchet, not decoration. The state machine's authority is
 * Postgres — the CHECKs below plus the compare-and-swap `UPDATE … WHERE state =
 * $expected` in `@/lib/documents/lifecycle` — precisely because a state-machine
 * library cannot hold an invariant across two processes, a retry and a
 * half-applied deploy. The one that matters most is
 * `document_versions_published_is_approved`: only a version a PERSON uploaded or
 * a person approved can ever be `published`, and only a published version is
 * ever dispatched to the index (slice 4). That makes "an agent-authored document the agent can
 * cite back to itself" a row the database refuses to store, rather than a
 * predicate in a retrieval path whose documented posture is fail-open.
 *
 * `(reviewed_by IS NULL) = (reviewed_at IS NULL)` is copied from
 * `tasks_review_complete` (migration 0075) for the reason that constraint gives:
 * a decision is by somebody, at some time, or it is not a decision.
 *
 * NOTE: the two partial unique indexes — one OPEN version per document, one
 * PUBLISHED version per document — live only in migration 0082 with their
 * `COMMENT ON INDEX`, because drizzle's index builder can express neither a
 * predicate over a value list nor the comment. Same arrangement as
 * `documents_conversation_idx`. `idx_document_versions_origin_conversation`
 * (migration 0084) is partial too and lives there for the same reason.
 */

import { relations, sql } from 'drizzle-orm'
import {
  check,
  foreignKey,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
} from 'drizzle-orm/pg-core'
import {
  DOCUMENT_SUBMIT_ACTORS,
  DOCUMENT_VERSION_ORIGINS,
  DOCUMENT_VERSION_STATES,
  type DocumentSubmitActor,
  type DocumentVersionOrigin,
  type DocumentVersionState,
} from '@/lib/documents/lifecycle-types'
import { documents } from './documents'

// Re-exported so `@/lib/db/schema` stays the one import site, exactly as
// `documents.ts` re-exports `DOCUMENT_AUTHORS`. The declaration itself lives
// outside the schema so a route handler can validate against it without
// importing drizzle — `server-component-db-access.spec.ts` fails on that.
export { DOCUMENT_VERSION_STATES, type DocumentVersionState }
export { DOCUMENT_SUBMIT_ACTORS, type DocumentSubmitActor }
export { DOCUMENT_VERSION_ORIGINS, type DocumentVersionOrigin }

/** The states as a SQL list, so the CHECK and the tuple cannot drift. */
const STATE_LIST = sql.raw(DOCUMENT_VERSION_STATES.map((state) => `'${state}'`).join(', '))

export const documentVersions = pgTable(
  'document_versions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: text('organization_id').notNull(),
    /**
     * The item, under TWO foreign keys (declared in the table's extras below).
     * The composite `(document_id, project_id)` one, the
     * `documents_folder_id_project_id_fkey` shape, binds the project so a version
     * cannot be filed against another project's document. The plain one
     * (migration 0094) binds existence, on every shelf — see `projectId`.
     */
    documentId: uuid('document_id').notNull(),
    /**
     * The document's project, denormalised so the composite foreign key and the
     * row-level-security predicate can both use it. NULL for the two shelves
     * that have no project — the org-wide Archiv and a conversation's private
     * attachments — exactly as `documents.project_id` is NULL for them. The
     * composite key is MATCH SIMPLE, so with this NULL it checks NOTHING — not
     * that the document exists, and on delete it cascades nothing either. That
     * once let an Archiv version outlive its document and be inserted for one
     * already deleted; `document_versions_document_id_fkey` (0094) is why it
     * cannot any more.
     */
    projectId: uuid('project_id'),
    /** 1, 2, 3 … within one document. Human-facing; not an id. */
    versionNumber: integer('version_number').notNull(),
    state: text('state').$type<DocumentVersionState>().notNull().default('draft'),
    /**
     * How the version began: a person's `upload`, or a `draft` that becomes
     * published only through an approval (migration 0137). Defaults to `draft`,
     * the direction that demands an approver, so a writer that forgets it is
     * refused by the CHECK rather than publishing unreviewed bytes.
     */
    origin: text('origin').$type<DocumentVersionOrigin>().notNull().default('draft'),
    /**
     * This version's own bytes. Two versions may share a key — see `forkDraft`.
     * Every key written after migration 0092 carries a per-write segment
     * (`v<n>/<write id>/<file>`), so two writers can never aim at one object.
     */
    storageKey: text('storage_key').notNull(),
    storageBucket: text('storage_bucket'),
    contentType: text('content_type'),
    fileSize: integer('file_size'),
    /** `sha256:<hex>` — the `If-Match` value a content replace must carry. */
    contentHash: text('content_hash'),
    /**
     * The `content_hash` of this version's bytes when a verdict passed them
     * (migration 0131, ADR-0086): the version's own screening verdict, which
     * the item's `screened_hash` cannot carry once newer bytes replace these.
     * It counts only while it equals `content_hash`, so a content write that
     * swaps the bytes leaves it behind and the version refused.
     *
     * One writer, `recordVersionVerdict` in `@/lib/documents/repository`, in
     * the transaction that records the item's verdict (the reconcile, a
     * reviewer's release): set on a pass, cleared on a quarantine of the same
     * bytes. A forked draft carries its source's value with the bytes it
     * copies. Read by `versionBytesPassedScreening`.
     */
    screenedHash: text('screened_hash'),
    submittedBy: text('submitted_by'),
    /**
     * Whose HAND submitted this version, as opposed to whose AUTHORITY it
     * carried (migration 0085).
     *
     * `submitted_by` is the person the submission was made AS — permissions,
     * the audit actor and the inbox all read it, and none of them changes. This
     * says whether a person or a run made the gesture, written from
     * `TransitionInput.actingHuman` at the submit transition so a caller cannot
     * tell the publish door one thing and this column another.
     *
     * The one reader is the not-the-submitter guard on `approve`. „Der
     * Einreichende darf nicht freigeben" is about a person asserting their own
     * work; a report Piloti filed in the commissioning human's session is not
     * their own work, and refusing them the Freigabe left an office with a
     * Befund nobody could release.
     */
    submittedByActor: text('submitted_by_actor')
      .$type<DocumentSubmitActor>()
      .notNull()
      .default('human'),
    submittedAt: timestamp('submitted_at', { withTimezone: true }),
    reviewedBy: text('reviewed_by'),
    reviewedAt: timestamp('reviewed_at', { withTimezone: true }),
    approvedBy: text('approved_by'),
    approvedAt: timestamp('approved_at', { withTimezone: true }),
    publishedBy: text('published_by'),
    publishedAt: timestamp('published_at', { withTimezone: true }),
    /** The reviewer's words. Required by a CHECK for the two refusing states. */
    reviewComment: text('review_comment'),
    createdBy: text('created_by').notNull(),
    /**
     * The chat conversation this version was filed from (migration 0084).
     *
     * Written from the VERIFIED request-context envelope at the internal filing
     * route and never off a request body, so it is a fact this tier asserted
     * (ADR-0054 §4). NULL for a human upload, a scheduled run, and any version
     * forked from the Files pane.
     *
     * PROVENANCE, never authorization. It decides two things and nothing else:
     * what the next turn of that conversation is told when a reviewer sends the
     * version back (`REVIEW_DECISIONS v1`), and whether a refused version needs
     * a `revision` task instead — a conversation gets the block, unattended
     * work gets the row.
     *
     * `text` with no foreign key, as `job_runs.conversation_id` is: the honest
     * constraint would be the composite `(conversation_id, organization_id)`,
     * which is worth its cost on a row that decides access and not on one that
     * decides prose.
     */
    originConversationId: text('origin_conversation_id'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    /**
     * One row per number per document (migration 0092). It replaced the plain
     * `idx_document_versions_document` on the same columns, which let two
     * overlapping re-uploads both record „Version 3". The number is allocated
     * inside the inserting transaction under a per-document lock
     * (`allocateVersionNumber` in `@/lib/documents/version-repository`); this is
     * what makes a forgotten lock a 23505 instead of a silent duplicate.
     */
    numberPerDocument: unique('document_versions_document_id_version_number_key').on(
      table.documentId,
      table.versionNumber,
    ),
    orgIdx: index('idx_document_versions_organization_id').on(table.organizationId),
    /**
     * Referenceable `(id, document_id)`, so `documents.published_version_id` can
     * bind the version to the item it belongs to. Declared here as well as in
     * migration 0082 because schema-driven provisioning builds the composite FK
     * from THIS file and Postgres rejects a reference whose target unique
     * constraint exists only in the migration.
     */
    idDocumentKey: unique('document_versions_id_document_id_key').on(table.id, table.documentId),
    documentProjectFk: foreignKey({
      name: 'document_versions_document_id_project_id_fkey',
      columns: [table.documentId, table.projectId],
      foreignColumns: [documents.id, documents.projectId],
    }).onDelete('cascade'),
    /** Existence, on every shelf: the composite key above checks nothing when `project_id` is NULL (migration 0094). */
    documentFk: foreignKey({
      name: 'document_versions_document_id_fkey',
      columns: [table.documentId],
      foreignColumns: [documents.id],
    }).onDelete('cascade'),
    stateKnown: check('document_versions_state_known', sql`${table.state} IN (${STATE_LIST})`),
    /** Two hands, and no third: see the column (migration 0085). */
    submitActorKnown: check(
      'document_versions_submitted_by_actor_known',
      sql`${table.submittedByActor} IN ('human', 'agent')`
    ),
    /** A review is by somebody, at some time — both or neither (`tasks_review_complete`). */
    reviewComplete: check(
      'document_versions_review_complete',
      sql`(${table.reviewedBy} IS NULL) = (${table.reviewedAt} IS NULL)`
    ),
    originKnown: check('document_versions_origin_known', sql`${table.origin} IN ('upload', 'draft')`),
    /**
     * The publish door, as a row invariant. Only a published version is
     * dispatched to the index, so "indexed" implies "a person put it there or a
     * person approved it" without any code being asked to remember. An upload
     * is the person's assertion and needs no approver (migration 0137).
     */
    publishedIsApproved: check(
      'document_versions_published_is_approved',
      sql`${table.state} <> 'published' OR ${table.origin} = 'upload' OR (${table.approvedBy} IS NOT NULL AND ${table.approvedAt} IS NOT NULL)`
    ),
    /**
     * A refusal carries words. „Änderungen anfordern" and „Ablehnen" both reach
     * the next turn and the revision task as text; a refusal with nothing in it
     * is a decision the next attempt cannot act on (ADR-0051's `review_reason`,
     * one level down).
     */
    refusalHasComment: check(
      'document_versions_refusal_has_comment',
      sql`${table.state} NOT IN ('changes_requested', 'rejected') OR ${table.reviewComment} IS NOT NULL`
    ),
  })
)

export const documentVersionsRelations = relations(documentVersions, ({ one }) => ({
  document: one(documents, {
    fields: [documentVersions.documentId],
    references: [documents.id],
  }),
}))

export type DocumentVersion = typeof documentVersions.$inferSelect
export type NewDocumentVersion = typeof documentVersions.$inferInsert

/** What a review round came to (migration 0136). `requested` while it is open. */
export const DOCUMENT_REVIEW_OUTCOMES = ['requested', 'approved', 'changes_requested', 'rejected'] as const
export type DocumentReviewOutcome = (typeof DOCUMENT_REVIEW_OUTCOMES)[number]

/**
 * One review round on one version (migration 0136, ADR-0104).
 *
 * Written in the transaction that moves the version's state
 * (`compareAndSwapVersionState`): a submit opens a round, an approval, a
 * request for changes or a rejection decides the open one. Nothing reads it
 * yet; the version's own columns stay authoritative until the readers move.
 * At most one round per version is open (`uniq_document_version_reviews_open_per_version`).
 */
export const documentVersionReviews = pgTable(
  'document_version_reviews',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: text('organization_id').notNull(),
    documentId: uuid('document_id').notNull(),
    versionId: uuid('version_id').notNull(),
    requestedBy: text('requested_by').notNull(),
    requestedByActor: text('requested_by_actor').$type<DocumentSubmitActor>().notNull(),
    requestedAt: timestamp('requested_at', { withTimezone: true }).notNull(),
    reviewerUserIds: text('reviewer_user_ids').array().notNull().default(sql`'{}'`),
    outcome: text('outcome').$type<DocumentReviewOutcome>().notNull().default('requested'),
    decidedBy: text('decided_by'),
    decidedAt: timestamp('decided_at', { withTimezone: true }),
    comment: text('comment'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    versionFk: foreignKey({
      name: 'document_version_reviews_version_fkey',
      columns: [table.versionId, table.documentId],
      foreignColumns: [documentVersions.id, documentVersions.documentId],
    }).onDelete('cascade'),
    documentIdx: index('idx_document_version_reviews_document').on(table.organizationId, table.documentId),
    actorKnown: check('document_version_reviews_actor_known', sql`${table.requestedByActor} IN ('human', 'agent')`),
    outcomeKnown: check(
      'document_version_reviews_outcome_known',
      sql`${table.outcome} IN (${sql.raw(DOCUMENT_REVIEW_OUTCOMES.map((outcome) => `'${outcome}'`).join(', '))})`
    ),
    decisionComplete: check(
      'document_version_reviews_decision_complete',
      sql`(${table.outcome} = 'requested') = (${table.decidedBy} IS NULL AND ${table.decidedAt} IS NULL)`
    ),
    refusalHasComment: check(
      'document_version_reviews_refusal_has_comment',
      sql`${table.outcome} NOT IN ('changes_requested', 'rejected') OR ${table.comment} IS NOT NULL`
    ),
  })
)

export type DocumentVersionReview = typeof documentVersionReviews.$inferSelect
export type NewDocumentVersionReview = typeof documentVersionReviews.$inferInsert
