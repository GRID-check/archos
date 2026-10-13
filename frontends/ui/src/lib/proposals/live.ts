import 'server-only'
/**
 * Publishing a decided proposal to its live channel (`proposal:<id>`,
 * `lib/realtime/proposal-channel.ts`). Separate from the channel definition so
 * the service can publish without importing the channel, which imports the
 * service to authorize.
 */

import { publish } from '@/lib/realtime/hub'
import { proposalEventSchema, proposalTopic, type ProposalEvent } from './live-events'

/**
 * Tell everyone reading this proposal that it was decided. Never throws: the
 * hub drops what it cannot deliver, and a reader who misses the hint finds the
 * decision on reload or on the 409 of their click, as before.
 */
export async function publishProposalDecided(
  proposalId: string,
  status: ProposalEvent['status']
): Promise<void> {
  await publish(proposalTopic(proposalId), proposalEventSchema.parse({ kind: 'proposal.decided', proposalId, status }))
}
