import { sql } from 'drizzle-orm'
import { check, foreignKey, index, integer, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core'
import {
  PROPOSAL_SCOPES,
  PROPOSED_CHANGE_KINDS,
  PROPOSED_CHANGE_STATUSES,
  type ProposalScope,
  type ProposedChangeKind,
  type ProposedChangeResult,
  type ProposedChangeStatus,
} from '@/lib/proposals/types'
import { conversations } from './conversations'
import { projects } from './projects'

const list = (values: readonly string[]) => sql.raw(values.map((value) => `'${value}'`).join(', '))

/** Who made the proposal; the contract's `proposedByKind`. */
export const PROPOSER_KINDS = ['piloti', 'person'] as const
export type ProposerKind = (typeof PROPOSER_KINDS)[number]

/** The statuses that carry `results`: the change was applied, whatever came of it. */
export const APPLIED_STATUSES = ['applied', 'partially_applied', 'failed'] as const satisfies readonly ProposedChangeStatus[]

/**
 * `proposed_changes` — a change to the workspace Piloti proposes and a person
 * applies (migration 0140, ADR-0105; `docs/architecture/proposed-changes.md`).
 *
 * `payload` is the contract's payload for `kind` (`lib/proposals/types.ts`),
 * parsed on every read. The CHECKs carry the lifecycle: decided exactly when
 * it left `proposed`, `results` exactly when it was applied, and the apply
 * claim (`applying_by`/`applying_since`) only while it is still `proposed`.
 */
export const proposedChanges = pgTable(
  'proposed_changes',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: text('organization_id').notNull(),
    /**
     * The project the change is for; NULL for a Büroablage (0146) or an
     * organization-scoped (0174) proposal, exactly when `scope` is not
     * `project` (`proposed_changes_scope_owner`).
     */
    projectId: uuid('project_id'),
    /**
     * The shelf (0146, 0174). A Büroablage proposal moves Büroablage documents
     * and nothing else (`proposed_changes_office_shelf_move`); an
     * organization's is an `operation` and nothing else
     * (`proposed_changes_organization_operation`).
     */
    scope: text('scope').$type<ProposalScope>().notNull().default('project'),
    kind: text('kind').$type<ProposedChangeKind>().notNull(),
    payload: jsonb('payload').$type<unknown>().notNull(),
    status: text('status').$type<ProposedChangeStatus>().notNull().default('proposed'),
    proposedByKind: text('proposed_by_kind').$type<ProposerKind>().notNull(),
    /** The person the proposal was made for: whose turn proposed it. */
    onBehalfOf: text('on_behalf_of').notNull(),
    originConversationId: text('origin_conversation_id'),
    originMessageId: uuid('origin_message_id'),
    /** Which card of that answer made it (0143): one card, one proposal, however often the turn's finish runs. */
    originCardIndex: integer('origin_card_index'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    decidedBy: text('decided_by'),
    decidedAt: timestamp('decided_at', { withTimezone: true }),
    results: jsonb('results').$type<ProposedChangeResult[]>(),
    /** The person applying it right now; cleared when the apply settles. */
    applyingBy: text('applying_by'),
    applyingSince: timestamp('applying_since', { withTimezone: true }),
    /**
     * The Langfuse trace of the judgement that proposed it (0146), for a
     * proposal no chat turn made: the decision is scored on it.
     */
    originTraceId: text('origin_trace_id'),
  },
  (table) => ({
    projectFk: foreignKey({
      name: 'proposed_changes_project_fkey',
      columns: [table.projectId, table.organizationId],
      foreignColumns: [projects.id, projects.organizationId],
    }).onDelete('cascade'),
    conversationFk: foreignKey({
      name: 'proposed_changes_conversation_fkey',
      columns: [table.originConversationId, table.organizationId],
      foreignColumns: [conversations.id, conversations.organizationId],
    }).onDelete('cascade'),
    organizationIdx: index('idx_proposed_changes_organization_id').on(table.organizationId),
    projectCreatedIdx: index('idx_proposed_changes_project_created').on(table.projectId, table.createdAt),
    conversationIdx: index('idx_proposed_changes_conversation').on(table.originConversationId),
    openIdx: index('idx_proposed_changes_open')
      .on(table.organizationId, table.scope, table.projectId)
      .where(sql`${table.status} = 'proposed'`),
    scopeKnown: check('proposed_changes_scope_known', sql`${table.scope} IN (${list(PROPOSAL_SCOPES)})`),
    scopeOwner: check('proposed_changes_scope_owner', sql`(${table.scope} = 'project') = (${table.projectId} IS NOT NULL)`),
    officeShelfMove: check(
      'proposed_changes_office_shelf_move',
      sql`${table.scope} <> 'office_shelf' OR COALESCE(${table.kind} = 'file_operation' AND ${table.payload}->>'operation' = 'move' AND jsonb_typeof(${table.payload}->'operations') = 'array' AND jsonb_path_exists(${table.payload}, '$.operations[0]') AND NOT jsonb_path_exists(${table.payload}, '$.operations[*] ? (!(@.source == "office"))'), false)`
    ),
    organizationOperation: check(
      'proposed_changes_organization_operation',
      sql`${table.scope} <> 'organization' OR ${table.kind} = 'operation'`
    ),
    // One open call, one proposal (0174): the same operation with the same input, in one conversation,
    // for one person (0176).
    openOperationUidx: uniqueIndex('uniq_proposed_changes_open_operation')
      .on(
        table.organizationId,
        table.originConversationId,
        table.onBehalfOf,
        sql`(${table.payload}->>'operation')`,
        sql`md5((${table.payload}->'input')::text)`
      )
      .where(sql`${table.kind} = 'operation' AND ${table.status} = 'proposed' AND ${table.originConversationId} IS NOT NULL`),
    originCardUidx: uniqueIndex('uniq_proposed_changes_origin_card')
      .on(table.organizationId, table.originMessageId, table.originCardIndex)
      .where(sql`${table.originCardIndex} IS NOT NULL`),
    cardIndexNonnegative: check(
      'proposed_changes_card_index_nonnegative',
      sql`${table.originCardIndex} IS NULL OR ${table.originCardIndex} >= 0`
    ),
    cardIndexNeedsMessage: check(
      'proposed_changes_card_index_needs_message',
      sql`${table.originCardIndex} IS NULL OR ${table.originMessageId} IS NOT NULL`
    ),
    kindKnown: check('proposed_changes_kind_known', sql`${table.kind} IN (${list(PROPOSED_CHANGE_KINDS)})`),
    statusKnown: check('proposed_changes_status_known', sql`${table.status} IN (${list(PROPOSED_CHANGE_STATUSES)})`),
    proposerKnown: check('proposed_changes_proposer_known', sql`${table.proposedByKind} IN (${list(PROPOSER_KINDS)})`),
    payloadObject: check('proposed_changes_payload_object', sql`jsonb_typeof(${table.payload}) = 'object'`),
    decisionComplete: check(
      'proposed_changes_decision_complete',
      sql`(${table.status} <> 'proposed') = (${table.decidedBy} IS NOT NULL) AND (${table.decidedBy} IS NULL) = (${table.decidedAt} IS NULL)`
    ),
    resultsWhenApplied: check(
      'proposed_changes_results_when_applied',
      sql`(${table.status} IN (${list(APPLIED_STATUSES)})) = (${table.results} IS NOT NULL)`
    ),
    resultsArray: check(
      'proposed_changes_results_array',
      sql`${table.results} IS NULL OR jsonb_typeof(${table.results}) = 'array'`
    ),
    claimComplete: check(
      'proposed_changes_claim_complete',
      sql`(${table.applyingBy} IS NULL) = (${table.applyingSince} IS NULL)`
    ),
    claimWhileProposed: check(
      'proposed_changes_claim_while_proposed',
      sql`${table.applyingBy} IS NULL OR ${table.status} = 'proposed'`
    ),
  })
)

export type ProposedChangeRow = typeof proposedChanges.$inferSelect
export type NewProposedChangeRow = typeof proposedChanges.$inferInsert
