'use client'

/**
 * A proposed change the server holds (ADR-0105), as a card reads and decides it.
 *
 * One hook for the three kinds, so the receipt cards cannot disagree about when
 * the object is read, when a colleague's decision is shown, or what a 409 means.
 * The object is the truth: this hook reads it when the card is shown, after
 * every decision, and when the channel says a colleague decided. It writes
 * nothing to the chat message (`cardInteractions`), because a decision kept on
 * the message would be a second truth beside the object. What the rest of the
 * answer needs to know of a decision (the „gemerkt“ chip) is told through
 * `decided-proposals`, a copy of the decided object, never through the message.
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import { applyProposal, dismissProposal, getProposal } from '@/lib/proposals/client'
import { proposalChannelKey, proposalEventSchema, type ProposalEvent } from '@/lib/proposals/live-events'
import type { ApplyProposalRequest, ProposedChangeKind, ProposedChangeView } from '@/lib/proposals/types'
import { useChannel } from '@/features/realtime/use-channel'
import { useDecidedProposals } from '../decided-proposals'

/** The proposal view of one kind: its payload is that kind's. */
export type ProposalOfKind<K extends ProposedChangeKind> = Extract<ProposedChangeView, { kind: K }>

/**
 * What went wrong, for the card to say in words. `load`: the object could not
 * be read (first read, or the re-read after a 409). `apply` / `dismiss`: the
 * click was refused for a reason other than a colleague deciding first.
 */
export type ProposalProblem = 'load' | 'apply' | 'dismiss'

/** What a press is doing. `withBody` marks the secondary apply (memory: only in the project). */
export interface ProposalBusy {
  action: 'apply' | 'dismiss'
  withBody: boolean
}

export interface ServerProposal<K extends ProposedChangeKind> {
  /** The object, once read; null before. A card draws its own copy of the payload until then. */
  proposal: ProposalOfKind<K> | null
  problem: ProposalProblem | null
  busy: ProposalBusy | null
  /** The click arrived after a colleague decided: their decision is what is shown. */
  overtaken: boolean
  decide: (action: 'apply' | 'dismiss', body?: ApplyProposalRequest) => Promise<void>
}

/** A refusal because the proposal is no longer `proposed`: somebody decided it first. */
const isConflict = (error: unknown): boolean =>
  typeof error === 'object' && error !== null && (error as { status?: unknown }).status === 409

const isKind = <K extends ProposedChangeKind>(kind: K, proposal: ProposedChangeView): proposal is ProposalOfKind<K> =>
  proposal.kind === kind

export function useServerProposal<K extends ProposedChangeKind>(
  proposalId: string,
  kind: K,
  /** Told every time the card takes a new decided state: its own click, a 409's re-read, a colleague's hint. */
  onSettled?: (proposal: ProposalOfKind<K>) => void
): ServerProposal<K> {
  const [proposal, setProposal] = useState<ProposalOfKind<K> | null>(null)
  const [problem, setProblem] = useState<ProposalProblem | null>(null)
  const [busy, setBusy] = useState<ProposalBusy | null>(null)
  const [overtaken, setOvertaken] = useState(false)

  const onSettledRef = useRef(onSettled)
  onSettledRef.current = onSettled

  // Every decided object this card holds, however it got it (the first read, a
  // 409's re-read, a colleague's hint, its own click), is told to the tab once.
  const recordDecided = useDecidedProposals((state) => state.record)
  useEffect(() => {
    if (proposal) recordDecided(proposal)
  }, [proposal, recordDecided])

  /** The object read from the server, if it is the kind this card shows. */
  const accept = useCallback(
    (read: ProposedChangeView): ProposalOfKind<K> | null => (isKind(kind, read) ? read : null),
    [kind]
  )

  useEffect(() => {
    let current = true
    getProposal(proposalId).then(
      (response) => {
        if (!current) return
        const read = accept(response.proposal)
        if (read) setProposal(read)
        else setProblem('load')
      },
      () => {
        if (current) setProblem('load')
      }
    )
    return () => {
      current = false
    }
  }, [proposalId, accept])

  const settle = useCallback((next: ProposalOfKind<K>): void => {
    setProposal(next)
    onSettledRef.current?.(next)
  }, [])

  // A colleague's decision, live. Once the first read shows the proposal open,
  // the card listens on `proposal:<id>` (a decided card listens to nothing). A
  // hint re-reads the object, and so does the channel coming up, which closes
  // the gap between that first read and the subscription; the object stays the
  // truth and the hint is never trusted as data. Nothing is applied while this
  // tab is deciding itself: its own response settles it, and a second settle
  // would tell the Files list twice.
  const open = proposal?.status === 'proposed'
  const live = useRef({ open, busy })
  live.current = { open, busy }
  const reread = useCallback(() => {
    void getProposal(proposalId).then(
      (response) => {
        if (!live.current.open || live.current.busy) return
        const read = accept(response.proposal)
        if (read && read.status !== 'proposed') settle(read)
      },
      () => undefined
    )
  }, [proposalId, accept, settle])
  const channel = useChannel<ProposalEvent>(proposalChannelKey(proposalId), {
    enabled: open,
    parse: (event) => {
      const parsed = proposalEventSchema.safeParse(event)
      return parsed.success && parsed.data.proposalId === proposalId ? parsed.data : null
    },
    onEvent: reread,
  })
  const channelStatus = channel.status
  useEffect(() => {
    if (channelStatus === 'live') reread()
  }, [channelStatus, reread])

  // `busy` reaches `live` only on the next render, so two presses in one tick
  // would both pass it; this ref is set before the first await.
  const inFlight = useRef(false)
  const decide = useCallback(
    async (action: 'apply' | 'dismiss', body?: ApplyProposalRequest): Promise<void> => {
      if (inFlight.current || live.current.busy) return
      inFlight.current = true
      setProblem(null)
      setBusy({ action, withBody: body !== undefined })
      try {
        const response = await (action === 'dismiss'
          ? dismissProposal(proposalId)
          : body
            ? applyProposal(proposalId, body)
            : applyProposal(proposalId))
        const read = accept(response.proposal)
        if (read) settle(read)
        else setProblem(action)
      } catch (failure) {
        if (!isConflict(failure)) {
          setProblem(action)
          return
        }
        setOvertaken(true)
        await getProposal(proposalId).then(
          (response) => {
            const read = accept(response.proposal)
            if (read) settle(read)
            else setProblem('load')
          },
          () => setProblem('load')
        )
      } finally {
        inFlight.current = false
        setBusy(null)
      }
    },
    [proposalId, accept, settle]
  )

  return { proposal, problem, busy, overtaken, decide }
}
