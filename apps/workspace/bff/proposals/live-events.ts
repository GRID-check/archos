/**
 * A decided proposal as a live channel hint (ADR-0110, ADR-0105): the
 * vocabulary of `proposal:<id>`, shared by the server that publishes it and the
 * card that reads it. No `server-only`: the browser parses these.
 *
 * The hint carries the new status and nothing else. The receiver re-reads the
 * proposal through its API (`GET /api/proposals/[id]`), which is where the
 * reader's own rights (`canDecide`, who decided, per-row results) are worked
 * out; the hint itself is never trusted as the data.
 */

import { z } from 'zod'
import type { ProposedChangeStatus } from './types'

/** The channel key a card opens for one proposal. */
export const proposalChannelKey = (proposalId: string) => `proposal:${proposalId}`

/** The hub topic the channel listens to. */
export const proposalTopic = (proposalId: string) => `rt:proposal:${proposalId}`

/** Everything but `proposed`: the statuses a decision leaves behind. */
export const proposalEventSchema = z.object({
  kind: z.literal('proposal.decided'),
  proposalId: z.string().min(1).max(128),
  status: z.enum(['applied', 'partially_applied', 'failed', 'dismissed'] as const satisfies readonly ProposedChangeStatus[]),
})
export type ProposalEvent = z.infer<typeof proposalEventSchema>
