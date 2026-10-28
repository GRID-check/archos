'use client'

/**
 * FileOperationProposalCard — the workspace change the agent proposed.
 *
 * One card for four verbs (move, rename, new folder, assign), switching on
 * `operation`, because the four differ in exactly one line: what each row of
 * the proposal SAYS (`./FileOperationRows`). The lifecycle is the proposal's.
 *
 * System-emitted (`aiq_agent/tools/files/`): the model cannot author one, so
 * every file named here is a file the tool resolved against the reader's own
 * inventory. What it must not claim is the change itself — the backend has no
 * path into `grid_app` (ADR-0003), so until a person applies it nothing has
 * happened at all, and the tool result told the model so in those words.
 *
 * ## A card is the receipt of a proposed change the server holds
 *
 * A card with a `proposal_id` is drawn by {@link FileOperationReceipt}
 * (ADR-0105, `lib/proposals`): it reads the object, shows its status, the
 * result per row (a batch whose third move failed says two moved and one did
 * not, with the reason, rather than „übernommen“) and who decided it, and its
 * buttons ask the server to apply or dismiss it in the deciding person's
 * session. Nothing runs in the browser and nothing is written to
 * `cardInteractions`.
 *
 * ## Without a `proposal_id`
 *
 * Nothing in the browser executes a proposal any more. A card without an id is
 * either from an answer older than server proposals, whose recorded decision
 * (`cardInteractions`) is replayed below so a file that was moved stays moved
 * in the transcript, or a proposal the agent could not store. That one is shown
 * read-only, with the reason, instead of offering an Accept that would write
 * from the browser what no server ever recorded.
 */

import { FolderTree } from 'lucide-react'
import { SectionLabel } from '@/components/ui/section-label'
import { useTranslations } from '@/i18n'
import { chatCopy } from '@/i18n/namespaces/chat'
import { useCardDecision } from '../hooks/use-card-decision'
import type { FileOperationItem, FileOperationKind } from '../lib/file-operations'
import { OperationList } from './FileOperationRows'
import { ProposalShell } from './ProposalShell'
import { FileOperationReceipt } from './ProposalReceipts'

interface FileOperationProposalCardProps {
  title: string
  operation: FileOperationKind
  operations: FileOperationItem[]
  note?: string | null
  /** Message this card belongs to — keys a decision recorded before server proposals. */
  messageId?: string
  /** Stable identity of this card within that message (`cardKey`). */
  cardKey: string
  /** Whether this surface requires the answer to be persisted. */
  decisionsMustPersist?: boolean
  /** The proposed change this card is a receipt of (ADR-0105). Absent: see „Without a `proposal_id`“. */
  proposalId?: string | null
}

export function FileOperationProposalCard({ proposalId, ...props }: FileOperationProposalCardProps) {
  return proposalId ? (
    <FileOperationReceipt
      proposalId={proposalId}
      title={props.title}
      operation={props.operation}
      operations={props.operations}
      note={props.note}
    />
  ) : (
    <UnstoredProposalCard {...props} />
  )
}

/**
 * FALLBACK for answers older than server proposals, and for a proposal the
 * agent could not store: read-only. A decision recorded on the message is shown
 * as it was; an undecided card says why it cannot be applied.
 */
function UnstoredProposalCard({
  title,
  operation,
  operations,
  note,
  messageId,
  cardKey,
  decisionsMustPersist,
}: Omit<FileOperationProposalCardProps, 'proposalId'>) {
  const t = useTranslations(chatCopy)
  const { decision } = useCardDecision(messageId, cardKey, { mustPersist: decisionsMustPersist })

  if (decision === 'accepted' || decision === 'partiallyApplied') {
    return (
      <ProposalShell tone="accepted">
        <p className="text-foreground text-sm">
          {decision === 'accepted'
            ? t(`cards.fileOperationProposal.applied.${operation}`, { count: operations.length })
            : t('cards.fileOperationProposal.partial')}
        </p>
      </ProposalShell>
    )
  }

  if (decision === 'rejected') {
    return (
      <ProposalShell tone="dismissed">
        <p className="text-muted-foreground text-sm">{t('cards.fileOperationProposal.dismissed')}</p>
      </ProposalShell>
    )
  }

  return (
    <ProposalShell tone="pending">
      <SectionLabel icon={FolderTree}>{t(`cards.fileOperationProposal.eyebrow.${operation}`)}</SectionLabel>

      <p className="text-foreground text-sm font-semibold">{title}</p>

      <OperationList operation={operation} items={operations} />

      {note && <p className="card-caption text-muted-foreground">{note}</p>}

      <p className="card-caption text-muted-foreground" data-testid="file-operation-unavailable">
        {t('cards.fileOperationProposal.notStored')}
      </p>
    </ProposalShell>
  )
}
