import { sql } from 'drizzle-orm'
import { check, foreignKey, index, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core'
import { ASK_STATES, type AskState } from '@/lib/piloti-asks/ask-wire'
import { conversations } from './conversations'

const list = (values: readonly string[]) => sql.raw(values.map((value) => `'${value}'`).join(', '))

/**
 * A question another agent asked Piloti on a person's behalf (ADR-0124,
 * migration 0179): one row per ask, whether it came through the MCP door
 * (`piloti-ask-create`) or the A2A door (`SendMessage`), which calls the same
 * route.
 *
 * The row is the A2A task. Its id is three things at once: the ask, the turn
 * id (the question's message id), and the A2A `Task.id`, so the turn's outcome
 * (`POST /api/internal/turns/outcome`) names its ask without a lookup table.
 * `conversation_id` is the A2A `contextId`: the person's own private thread the
 * turn runs in, readable in Piloti like any other.
 *
 * `state` uses the A2A task-state words, lowercase. `reason` is set exactly
 * for `failed` and `rejected`; `ended_at` exactly for a terminal state.
 */
export const pilotiAsks = pgTable(
  'agent_asks',
  {
    id: uuid('id').primaryKey(),
    organizationId: text('organization_id').notNull(),
    conversationId: text('conversation_id').notNull(),
    /** The person the asking agent acts for: the turn runs as them, on their budget. */
    requestedBy: text('requested_by').notNull(),
    state: text('state').$type<AskState>().notNull().default('submitted'),
    /** Why it failed or was rejected, user-safe; set exactly for those two states. */
    reason: text('reason'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    endedAt: timestamp('ended_at', { withTimezone: true }),
  },
  (table) => ({
    conversationFk: foreignKey({
      name: 'agent_asks_conversation_fkey',
      columns: [table.conversationId, table.organizationId],
      foreignColumns: [conversations.id, conversations.organizationId],
    }).onDelete('cascade'),
    requesterIdx: index('idx_agent_asks_requester_created').on(
      table.organizationId,
      table.requestedBy,
      table.createdAt,
    ),
    conversationIdx: index('idx_agent_asks_conversation').on(table.conversationId),
    stateKnown: check('agent_asks_state_known', sql`${table.state} IN (${list(ASK_STATES)})`),
    reasonWhenRefused: check(
      'agent_asks_reason_when_refused',
      sql`(${table.state} IN ('failed', 'rejected')) = (${table.reason} IS NOT NULL)`,
    ),
    reasonLength: check(
      'agent_asks_reason_length',
      sql`${table.reason} IS NULL OR char_length(${table.reason}) BETWEEN 1 AND 500`,
    ),
    endedWhenTerminal: check(
      'agent_asks_ended_when_terminal',
      sql`(${table.state} IN ('submitted', 'working')) = (${table.endedAt} IS NULL)`,
    ),
  }),
)

export type PilotiAskRow = typeof pilotiAsks.$inferSelect
