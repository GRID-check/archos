/**
 * What Piloti reads back when its write became a proposal, or did not
 * (`discovery.ts`, `runOperation`). The structured shape is what the
 * in-product client reads to show the card (`tools/workspace/register.py`):
 * `structuredContent.decision === 'propose'` with the proposal's id. The text
 * is all the model reads.
 */

import type { CallToolResult } from '@modelcontextprotocol/server'
import type { AgentOperation } from './operation'
import type { ProposedOperation } from './operation-proposals'

/** A proposal filed: the person decides; the operation's warnings ride along for the model (`checkProposal`). */
export function proposedAnswer(op: Pick<AgentOperation, 'name'>, proposal: ProposedOperation): CallToolResult {
  const warned = proposal.warnings?.length ? ` Layout warnings, fix them with a new call if they matter: ${proposal.warnings.join('; ')}.` : ''
  return {
    content: [{ type: 'text', text: `Proposed — the person decides. Nothing was changed.${warned}` }],
    structuredContent: { decision: 'propose', proposalId: proposal.proposalId, summary: proposal.summary, operation: op.name },
  }
}

/** Nothing filed and no card (`ProposalDeclined`): the model relays the reason itself. */
export function declinedAnswer(op: Pick<AgentOperation, 'name'>, note: string): CallToolResult {
  return {
    content: [{ type: 'text', text: `Nothing proposed and nothing changed; tell the person why: ${note}` }],
    structuredContent: { decision: 'declined', operation: op.name, note },
  }
}
