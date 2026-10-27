'use client'

/**
 * How a receipt card reaches the proposal it shows (ADR-0105): the seam
 * between {@link useServerProposal} and the server.
 *
 * In Piloti's own pages that is the typed HTTP client (`lib/proposals/client`)
 * in the reader's session, and the realtime channel for a colleague's decision.
 * Inside another assistant's chat the same card is an MCP App (ADR-0142): it
 * has no cookie and no network, and reads and decides through the host's
 * `tools/call` to Piloti's MCP door, which runs the same routes as the person
 * (`features/mcp-apps/proposal-card/app-transport.ts`). Either way the route is
 * the gate; this only says which client carries the call.
 *
 * A refusal is a `ProposalRequestError` with the route's status, so a 409
 * (somebody decided first) reads the same through both.
 */

import { createContext, useContext } from 'react'
import { applyProposal, dismissProposal, getProposal } from '@/lib/proposals/client'
import type { ApplyProposalRequest, ProposalResponse } from '@/lib/proposals/types'

export interface ProposalTransport {
  get(id: string): Promise<ProposalResponse>
  apply(id: string, body?: ApplyProposalRequest): Promise<ProposalResponse>
  dismiss(id: string): Promise<ProposalResponse>
  /** Whether a colleague's decision can arrive live (the realtime channel). Off where there is no channel. */
  readonly live: boolean
}

/** The browser in Piloti: the reader's own session, and the channel. */
export const HTTP_PROPOSAL_TRANSPORT: ProposalTransport = {
  get: (id) => getProposal(id),
  apply: (id, body) => (body ? applyProposal(id, body) : applyProposal(id)),
  dismiss: (id) => dismissProposal(id),
  live: true,
}

const ProposalTransportContext = createContext<ProposalTransport>(HTTP_PROPOSAL_TRANSPORT)

export const ProposalTransportProvider = ProposalTransportContext.Provider

export function useProposalTransport(): ProposalTransport {
  return useContext(ProposalTransportContext)
}
