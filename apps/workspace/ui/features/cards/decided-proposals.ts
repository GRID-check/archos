/**
 * The proposed changes this tab has seen decided, by proposal id (ADR-0105).
 *
 * A card with a `proposal_id` keeps its decision on the server and writes
 * nothing to the chat message (`cardInteractions`, see `card-decision.ts`).
 * Surfaces outside the card that need to know how it ended, like the „Piloti hat
 * sich gemerkt“ chip in the answer's footer (`turnMemoryItems`), therefore read
 * it from here: `useServerProposal` records every decided object it reads, hears
 * of through the channel, or produces by its own click. One read serves the
 * receipt and everything beside it; nothing is fetched twice.
 *
 * Only decided proposals are recorded, and the server is the truth: this is a
 * copy of what a receipt already holds, not a second record. Not persisted; a
 * reload mounts the receipts again and they record again.
 */

import { create } from 'zustand'
import type { ProposedChangeView } from '@/lib/proposals/types'

export type DecidedProposals = Readonly<Record<string, ProposedChangeView>>

interface DecidedProposalsState {
  byId: DecidedProposals
  record: (proposal: ProposedChangeView) => void
}

export const useDecidedProposals = create<DecidedProposalsState>()((set) => ({
  byId: {},
  record: (proposal) => {
    if (proposal.status === 'proposed') return
    set((state) => (state.byId[proposal.id] === proposal ? state : { byId: { ...state.byId, [proposal.id]: proposal } }))
  },
}))

/** Specs only: forget every recorded decision. */
export const resetDecidedProposals = (): void => useDecidedProposals.setState({ byId: {} })
