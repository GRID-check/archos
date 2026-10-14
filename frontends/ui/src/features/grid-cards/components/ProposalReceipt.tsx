'use client'

/**
 * ProposalReceipt — the one card for a proposed change the server holds
 * (ADR-0105), whatever its kind.
 *
 * A file operation, a memory note and a change to the project profile are
 * three bodies in one frame. The frame is what they share and what must not
 * drift between them: it reads the proposal, shows its status, says who decided
 * it and when („Übernommen von Anna · 14:02“), offers „Übernehmen“ and
 * „Verwerfen“ only when the server says this reader may decide
 * (`canDecide`), and turns a colleague's earlier decision (a 409, or the
 * channel) into that colleague's receipt instead of an error. A decision is a
 * write to the proposal and nothing else: no `cardInteractions`.
 *
 * What differs is passed in: the eyebrow and title, the body while the
 * proposal is open, the headline and body once it is decided, and, for a
 * memory note, one secondary way to apply it ({@link ProposalReceiptProps.alternative}).
 * Each kind's body lives in `./proposal-receipt-bodies`.
 */

import type { ComponentProps, ReactNode } from 'react'
import { Button } from '@/components/ui/button'
import { useLocale, useTranslations } from '@/i18n'
import { formatAbsoluteTime } from '@/lib/format'
import type { ApplyProposalRequest, ProposedChangeKind, ProposedChangeStatus } from '@/lib/proposals/types'
import type { ProposalOfKind, ServerProposal } from '../hooks/use-server-proposal'
import { ProposalShell } from './ProposalShell'
import { StackedLabel } from '@/components/ui/stacked-label'

type ProposalTone = ComponentProps<typeof ProposalShell>['tone']

/**
 * The shell's accent per server status. A failed proposal changed nothing, so
 * it does not borrow the green of an applied one; its words carry the failure.
 */
const STATUS_TONE: Record<ProposedChangeStatus, ProposalTone> = {
  proposed: 'pending',
  applied: 'accepted',
  partially_applied: 'accepted',
  failed: 'dismissed',
  dismissed: 'dismissed',
}

const HEADLINE_CLASS: Record<ProposedChangeStatus, string> = {
  proposed: 'text-foreground text-sm',
  applied: 'text-foreground text-sm',
  partially_applied: 'text-foreground text-sm',
  failed: 'text-destructive text-sm',
  dismissed: 'text-muted-foreground text-sm',
}

export interface ProposalReceiptProps<K extends ProposedChangeKind> {
  server: ServerProposal<K>
  /** A small label above the title (the file verb); omitted when the title says it. */
  eyebrow?: ReactNode
  title: string
  /** The body while the proposal is open: the stored object once read, the card's own copy before. */
  open: ReactNode
  /** The first line of the decided card: what happened. */
  headline: (proposal: ProposalOfKind<K>) => string
  /** What sits under the headline once decided: per-row results, a failure's reason. */
  decidedBody?: (proposal: ProposalOfKind<K>) => ReactNode
  /** A second way to apply, beside „Übernehmen“: the memory note filed in the project only. */
  alternative?: { label: string; working: string; body: ApplyProposalRequest }
}

export function ProposalReceipt<K extends ProposedChangeKind>({
  server,
  eyebrow,
  title,
  open,
  headline,
  decidedBody,
  alternative,
}: ProposalReceiptProps<K>) {
  const t = useTranslations('chat')
  const { locale } = useLocale()
  const { proposal, problem, busy, overtaken, decide } = server

  if (proposal && proposal.status !== 'proposed') {
    const { status } = proposal
    return (
      <ProposalShell tone={STATUS_TONE[status]}>
        <p className={HEADLINE_CLASS[status]} data-testid="proposal-status" data-status={status}>
          {headline(proposal)}
        </p>
        {decidedBody?.(proposal)}
        {overtaken && (
          <p className="card-caption text-muted-foreground" data-testid="proposal-overtaken">
            {t('cards.proposalReceipt.overtaken')}
          </p>
        )}
        {proposal.decidedAt && (
          <p className="card-caption text-muted-foreground" data-testid="proposal-decided-by">
            {t(`cards.proposalReceipt.decidedBy.${status}`, {
              name: proposal.decidedByName ?? t('cards.proposalReceipt.someone'),
              when: formatAbsoluteTime(proposal.decidedAt, locale),
            })}
          </p>
        )}
      </ProposalShell>
    )
  }

  const pressed = busy !== null
  return (
    <ProposalShell tone="pending">
      {eyebrow}
      <p className="text-foreground text-sm font-semibold">{title}</p>
      {open}

      {/* Why there is nothing to press, stated where the buttons would be:
          the object could not be read, or the server says this reader may not
          decide it (no write access to the project). */}
      {problem === 'load' && (
        <p className="card-caption text-muted-foreground" data-testid="proposal-unavailable">
          {t('cards.proposalReceipt.loadError')}
        </p>
      )}
      {proposal && !proposal.canDecide && (
        <p className="card-caption text-muted-foreground" data-testid="proposal-unavailable">
          {t('cards.proposalReceipt.readOnly')}
        </p>
      )}

      {(problem === 'apply' || problem === 'dismiss') && (
        <p className="text-destructive text-sm">
          {problem === 'apply' ? t('cards.proposalReceipt.applyError') : t('cards.proposalReceipt.dismissError')}
        </p>
      )}

      {/* `flex-wrap`: at 390px „Übernehmen?" and the buttons do not fit on one
          line, and a non-wrapping row put the question UNDER the primary
          button. Wrapped, the question takes its own line and the buttons stay
          right-aligned beneath it.

          BUSY, NOT DISABLED, while a press is in flight: `disabled` on the
          button the reader just pressed dropped their focus to <body>.
          `aria-disabled` keeps it, the handler ignores a second press, and
          `StackedLabel` keeps the button as wide as its longer label. */}
      {proposal?.canDecide && (
        <div className="flex flex-wrap items-center justify-end gap-2">
          <p className="text-muted-foreground mr-auto text-sm">{t('cards.proposalReceipt.prompt')}</p>
          {alternative && (
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => void decide('apply', alternative.body)}
              aria-disabled={pressed || undefined}
              aria-busy={(busy?.action === 'apply' && busy.withBody) || undefined}
              className="aria-disabled:cursor-default"
            >
              <StackedLabel
                busy={busy?.action === 'apply' && busy.withBody}
                idle={alternative.label}
                working={alternative.working}
              />
            </Button>
          )}
          <Button
            type="button"
            size="sm"
            onClick={() => void decide('apply')}
            aria-disabled={pressed || undefined}
            aria-busy={(busy?.action === 'apply' && !busy.withBody) || undefined}
            className="aria-disabled:cursor-default"
          >
            <StackedLabel
              busy={busy?.action === 'apply' && !busy.withBody}
              idle={t('cards.proposalReceipt.accept')}
              working={t('cards.proposalReceipt.applying')}
            />
          </Button>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => void decide('dismiss')}
            aria-disabled={pressed || undefined}
            aria-busy={busy?.action === 'dismiss' || undefined}
            className="aria-disabled:cursor-default aria-disabled:opacity-50"
          >
            {t('cards.proposalReceipt.reject')}
          </Button>
        </div>
      )}
    </ProposalShell>
  )
}
