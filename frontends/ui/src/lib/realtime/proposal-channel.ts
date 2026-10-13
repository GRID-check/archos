/**
 * A proposal as a live channel: `proposal:<proposalId>` (ADR-0104, ADR-0105).
 *
 * Being in the channel is reading the proposal, by the same rule as
 * `GET /api/proposals/[id]`: `project:view` on its project AND `viewer` on the
 * conversation it was made in (`requireReadableProposal`). A reader the card is
 * not shown to has no channel, and one whose access is withdrawn is dropped at
 * the next re-check.
 *
 * The browsers say nothing here (no upstream); the one speaker is the proposals
 * service, once, when a proposal is applied or dismissed
 * (`lib/proposals/live.ts`). The event is a hint: the card re-reads the proposal.
 */

import 'server-only'
import { proposalEventSchema, proposalTopic } from '@/lib/proposals/live-events'
import { requireReadableProposal } from '@/lib/proposals/service'
import { defineChannel } from './channel'

/** How often an open stream checks that its reader may still read the proposal. */
export const PROPOSAL_REAUTHORIZE_MS = 30_000

const PROPOSAL_ID = /^[A-Za-z0-9_-]{1,128}$/

export const proposalChannel = defineChannel({
  kind: 'proposal',
  parse: (id) => (PROPOSAL_ID.test(id) ? { proposalId: id } : null),
  topics: ({ proposalId }) => [proposalTopic(proposalId)],
  authorize: async (session, { proposalId }) => {
    await requireReadableProposal(session, proposalId)
  },
  reauthorizeMs: PROPOSAL_REAUTHORIZE_MS,
  events: proposalEventSchema,
})
