'use client'

/**
 * A stored proposal as the catalog's card (ADR-0065), and the renderer the
 * A2UI surface draws it with (ADR-0142).
 *
 * The card types are the ones Piloti's chat shows for the same proposal
 * (`operation_proposal`, `file_operation_proposal`, `memory_proposal`), each
 * with its `proposal_id`, so the receipt the chat draws is the receipt drawn
 * here: same component, same copy, same decision rules (`ProposalReceipt`).
 * Only the transport differs (`app-transport.ts`).
 *
 * A change to the project context (`project_profile`) is not drawn: its card
 * compares the patch with the live profile, which the frame cannot read, and a
 * card without the "before" would ask the person to decide on half of it. It
 * says so and sends them to Piloti.
 */

import type { ReactNode } from 'react'
import { answerCardSchema, type AnswerCard } from '@/shared/cards/schemas'
import type { ProposedChangeView } from '@/lib/proposals/types'
import type { CardRenderer } from '@/features/a2ui/catalog'
import { FileOperationReceipt, MemoryReceipt, OperationReceipt } from '@/features/cards/components/ProposalReceipts'

export interface ProposalTitles {
  /** A file proposal carries no title of its own: `{count} changes to files`. */
  files: (count: number) => string
  /** Nor does a note. */
  memory: string
}

/**
 * What the frame draws for `proposal`: its catalog card; `not-drawn` for a kind
 * this frame does not draw (decided in Piloti); `invalid` for one whose card
 * the card's own schema refuses, which is unreadable, not a kind to send away.
 * Validated by the card's generated schema, the one a card in the chat is
 * validated by, which also fills its defaults.
 */
export type DrawnProposal = { kind: 'card'; card: AnswerCard } | { kind: 'not-drawn' } | { kind: 'invalid' }

export function cardOfProposal(proposal: ProposedChangeView, titles: ProposalTitles): DrawnProposal {
  const raw = rawCardOf(proposal, titles)
  if (!raw) return { kind: 'not-drawn' }
  const parsed = answerCardSchema.safeParse(raw)
  return parsed.success ? { kind: 'card', card: parsed.data } : { kind: 'invalid' }
}

function rawCardOf(proposal: ProposedChangeView, titles: ProposalTitles): Record<string, unknown> | null {
  switch (proposal.kind) {
    case 'operation':
      return {
        type: 'operation_proposal',
        proposal_id: proposal.id,
        title: proposal.payload.summary,
        operation: proposal.payload.operation,
        input: proposal.payload.input,
      }
    case 'file_operation':
      return {
        type: 'file_operation_proposal',
        proposal_id: proposal.id,
        title: titles.files(proposal.payload.operations.length),
        operation: proposal.payload.operation,
        operations: proposal.payload.operations,
        note: proposal.payload.note ?? null,
      }
    case 'memory':
      return {
        type: 'memory_proposal',
        proposal_id: proposal.id,
        title: titles.memory,
        content: proposal.payload.content,
        kind: proposal.payload.kind,
        confidence: proposal.payload.confidence,
        supersedes: proposal.payload.supersedes ?? null,
      }
    case 'project_profile':
      return null
  }
}

/** Draws the three receipt cards; anything else this frame never builds. */
export const renderProposalCard: CardRenderer = (card): ReactNode => {
  switch (card.type) {
    case 'operation_proposal':
      return <OperationReceipt proposalId={card.proposal_id} title={card.title} operation={card.operation} input={card.input ?? {}} />
    case 'file_operation_proposal':
      return card.proposal_id ? (
        <FileOperationReceipt
          proposalId={card.proposal_id}
          title={card.title}
          operation={card.operation}
          operations={card.operations}
          note={card.note}
        />
      ) : null
    case 'memory_proposal':
      return card.proposal_id ? (
        <MemoryReceipt
          proposalId={card.proposal_id}
          title={card.title}
          content={card.content}
          kind={card.kind}
          confidence={card.confidence}
          supersedes={card.supersedes}
        />
      ) : null
    default:
      return null
  }
}
