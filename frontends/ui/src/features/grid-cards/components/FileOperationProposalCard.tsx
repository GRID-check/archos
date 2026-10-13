'use client'

/**
 * FileOperationProposalCard — the workspace change the agent proposed.
 *
 * One component for four verbs, switching on `operation`, because the four
 * differ in exactly one line: what each row of the proposal SAYS. Everything
 * else — the proposal shell, the pending/accepted/dismissed lifecycle, the
 * persisted decision, the partial-failure report — is the same object four
 * times over, and four components would be four places to fix the fifth bug.
 *
 * System-emitted (`aiq_agent/tools/files/`): the model cannot author one, so
 * every file named here is a file the tool resolved against the reader's own
 * inventory. What it must not claim is the change itself — the backend has no
 * path into `grid_app` (ADR-0003), so until this card is accepted nothing has
 * happened at all, and the tool result told the model so in those words.
 *
 * ## Why the outcome is per row
 *
 * A card can carry several operations of one kind („räum die
 * Einreichunterlagen zusammen" is four moves). They are applied in order and
 * each one's result is kept, so a card whose third move failed says three
 * moved and one did not, with the reason — rather than „übernommen", which
 * would be a lie about one file, or „fehlgeschlagen", which would be a lie
 * about three.
 *
 * ## How a decision lands
 *
 * Each row carries a status slot from the first paint, empty while the card
 * waits, so a row's ✓ or ✗ arrives without moving its text. The rows say what
 * happened first, and the card changes state one beat later
 * ({@link ROW_BEAT_MS}): watched together they were one jump, and the reader
 * never saw which file had moved. The busy button keeps its width (both labels
 * are stacked in one cell) and its focus (`aria-disabled`, never `disabled`:
 * Chrome blurs a focused button the moment it becomes disabled).
 *
 * ## Two ways a card is decided
 *
 * A card with a `proposal_id` is a receipt of a proposed change the server
 * holds (ADR-0105, `lib/proposals`). It reads that object when it is shown and
 * after every decision, draws the object's status and who decided it, and its
 * buttons ask the server to apply or dismiss it in the deciding person's
 * session. Nothing runs in the browser and nothing is written to
 * `cardInteractions`: the object is the truth, so a colleague who decided it
 * first is what the card shows ({@link ServerProposalCard}).
 *
 * A card without one (stored before proposals were objects, or the agent's
 * fallback when it could not create one) keeps the older contract: Accept runs
 * the operations from the browser and the decision is kept on the message
 * ({@link BrowserAppliedCard}).
 */

import { useCallback, useEffect, useRef, useState, type ComponentProps } from 'react'
import { Check, FolderTree, X } from 'lucide-react'
import { motion, motionDeliberate, useIconSwapTransition } from '@/components/motion'
import { Button } from '@/components/ui/button'
import { SectionLabel } from '@/components/ui/section-label'
import { useLocale, useTranslations } from '@/i18n'
import { formatAbsoluteTime } from '@/lib/format'
import { applyProposal, dismissProposal, getProposal } from '@/lib/proposals/client'
import { proposalChannelKey, proposalEventSchema, type ProposalEvent } from '@/lib/proposals/live-events'
import type { ProposedChangeStatus, ProposedChangeView } from '@/lib/proposals/types'
import { useChatStore } from '@/features/chat/store'
import { useChannel } from '@/features/realtime/use-channel'
import { useCardDecision } from '../hooks/use-card-decision'
import {
  applyFileOperations,
  notifyIfAnyApplied,
  operationLabel,
  type FileOperationItem,
  type FileOperationKind,
  type FileOperationResult,
} from '../lib/file-operations'
import { ProposalShell } from './ProposalShell'
import { StackedLabel } from './StackedLabel'

/** How long the rows' verdicts stand before the card takes its decided state. */
const ROW_BEAT_MS = (motionDeliberate.duration ?? 0) * 1000

interface FileOperationProposalCardProps {
  title: string
  operation: FileOperationKind
  operations: FileOperationItem[]
  note?: string | null
  /** Message this card belongs to — keys its persisted decision. */
  messageId?: string
  /** Stable identity of this card within that message (`cardKey`). */
  cardKey: string
  /** Whether this surface requires the answer to be persisted. */
  decisionsMustPersist?: boolean
  /**
   * The proposed change this card is a receipt of, when the server holds one
   * (ADR-0105). Present: the server decides. Absent: the browser runs it.
   */
  proposalId?: string | null
}

/** The project root has no path to print; it has a name the reader knows. */
const folderText = (path: string | null | undefined, rootLabel: string): string =>
  path && path.trim() ? path : rootLabel

/**
 * One row: what this operation does, in the operation's own words.
 *
 * Rendered as „from → to" wherever there IS a from — the reader is deciding
 * about a change, and a change the card only states the destination of asks
 * them to remember where the file is now.
 */
function OperationRow({
  operation,
  item,
  result,
}: {
  operation: FileOperationKind
  item: FileOperationItem
  result?: FileOperationResult
}) {
  const t = useTranslations('chat')
  const root = t('cards.fileOperationProposal.root')

  const subject =
    operation === 'create_folder' ? folderText(item.folder_name, root) : (item.document ?? '')
  const target =
    operation === 'move'
      ? folderText(item.target_folder, root)
      : operation === 'rename'
        ? (item.new_display_name ?? '')
        : operation === 'assign'
          ? (item.member ?? '')
          : folderText(item.parent_folder, root)
  const from = operation === 'move' ? folderText(item.current, root) : ''

  return (
    <li
      className="card-caption text-foreground flex items-baseline gap-x-1.5"
      data-testid="file-operation-row"
    >
      <RowStatus result={result} />
      <span className="flex min-w-0 flex-1 flex-wrap items-baseline gap-x-2">
        <span className="min-w-0 truncate font-medium" title={subject}>
          {subject}
        </span>
        {from ? (
          <span className="text-muted-foreground">
            {from} <span aria-hidden>→</span>{' '}
          </span>
        ) : (
          <span aria-hidden className="text-muted-foreground">
            →
          </span>
        )}
        <span className="text-muted-foreground min-w-0 truncate" title={target}>
          {target}
        </span>
        {result && !result.ok && (
          <span className="text-destructive" data-testid="file-operation-row-error">
            {result.reason}
          </span>
        )}
      </span>
    </li>
  )
}

/** Every row of the proposal, each with its verdict once there is one. */
function OperationList({
  operation,
  items,
  results,
}: {
  operation: FileOperationKind
  items: readonly FileOperationItem[]
  results?: readonly FileOperationResult[] | null
}) {
  return (
    <ul className="flex flex-col gap-1" data-testid="file-operation-rows">
      {items.map((item, index) => (
        <OperationRow
          key={`${operationLabel(operation, item)}-${index}`}
          operation={operation}
          item={item}
          result={results?.[index]}
        />
      ))}
    </ul>
  )
}

/**
 * A row's verdict, in a slot that is there before it: the check pops in as an
 * icon swap (scale on the snap spring, opacity on a tween), a failure is a quiet ✗ beside the reason the row prints.
 */
function RowStatus({ result }: { result?: FileOperationResult }) {
  const swap = useIconSwapTransition()
  const Icon = result ? (result.ok ? Check : X) : null
  return (
    <span className="inline-flex size-3.5 shrink-0 self-center" aria-hidden>
      {Icon && (
        <motion.span
          className={result?.ok ? 'text-success' : 'text-destructive'}
          initial={{ opacity: 0, scale: 0.7 }}
          animate={{ opacity: 1, scale: 1, transition: swap.enter }}
          data-testid={result?.ok ? 'file-operation-row-ok' : 'file-operation-row-failed'}
        >
          <Icon className="size-3.5" />
        </motion.span>
      )}
    </span>
  )
}

export function FileOperationProposalCard({ proposalId, ...props }: FileOperationProposalCardProps) {
  return proposalId ? <ServerProposalCard {...props} proposalId={proposalId} /> : <BrowserAppliedCard {...props} />
}

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

/** A refusal because the proposal is no longer `proposed`: somebody decided it first. */
const isConflict = (error: unknown): boolean =>
  typeof error === 'object' && error !== null && (error as { status?: unknown }).status === 409

/**
 * A card that is the receipt of a server-held proposed change (ADR-0105).
 *
 * The rows come from the object once it has been read (the card's own copy is
 * what the first paint shows), and so do the results per row, the status and
 * who decided. `canDecide` is the server's word on whether this reader may
 * press anything, and a 409 means a colleague was faster: the card reads the
 * object again and shows their decision instead of an error.
 */
function ServerProposalCard({
  proposalId,
  title,
  operation,
  operations,
  note,
}: Omit<FileOperationProposalCardProps, 'proposalId'> & { proposalId: string }) {
  const t = useTranslations('chat')
  const { locale } = useLocale()
  const [proposal, setProposal] = useState<ProposedChangeView | null>(null)
  const [loadFailed, setLoadFailed] = useState(false)
  const [busy, setBusy] = useState<'apply' | 'dismiss' | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [overtaken, setOvertaken] = useState(false)

  useEffect(() => {
    let current = true
    getProposal(proposalId).then(
      (response) => {
        if (current) setProposal(response.proposal)
      },
      () => {
        if (current) setLoadFailed(true)
      }
    )
    return () => {
      current = false
    }
  }, [proposalId])

  // After a decision, the object as it now stands. A colleague's apply changed
  // files too, so the Files list is told either way.
  const settle = (next: ProposedChangeView): void => {
    setProposal(next)
    notifyIfAnyApplied(next.results)
  }

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
  const settleRef = useRef(settle)
  settleRef.current = settle
  const reread = useCallback(() => {
    void getProposal(proposalId).then(
      (response) => {
        if (!live.current.open || live.current.busy) return
        if (response.proposal.status !== 'proposed') settleRef.current(response.proposal)
      },
      () => undefined
    )
  }, [proposalId])
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

  const decide = async (action: 'apply' | 'dismiss'): Promise<void> => {
    if (busy) return
    setError(null)
    setBusy(action)
    try {
      const response = await (action === 'apply' ? applyProposal : dismissProposal)(proposalId)
      settle(response.proposal)
    } catch (failure) {
      if (!isConflict(failure)) {
        setError(t(action === 'apply' ? 'cards.fileOperationProposal.error' : 'cards.fileOperationProposal.live.dismissError'))
        return
      }
      setOvertaken(true)
      await getProposal(proposalId).then(
        (response) => settle(response.proposal),
        () => setError(t('cards.fileOperationProposal.live.loadError'))
      )
    } finally {
      setBusy(null)
    }
  }

  const verb = proposal?.payload.operation ?? operation
  const items: readonly FileOperationItem[] = proposal?.payload.operations ?? operations
  const status: ProposedChangeStatus = proposal?.status ?? 'proposed'
  const tone = STATUS_TONE[status]

  if (proposal && status !== 'proposed') {
    const applied = proposal.results?.filter((result) => result.ok).length ?? 0
    const summary =
      status === 'applied'
        ? t(`cards.fileOperationProposal.applied.${verb}`, { count: items.length })
        : status === 'partially_applied'
          ? t('cards.fileOperationProposal.live.partial', { applied, total: items.length })
          : status === 'failed'
            ? t('cards.fileOperationProposal.live.failed')
            : t('cards.fileOperationProposal.dismissed')
    return (
      <ProposalShell tone={tone}>
        <p
          className={status === 'failed' ? 'text-destructive text-sm' : status === 'dismissed' ? 'text-muted-foreground text-sm' : 'text-foreground text-sm'}
          data-testid="file-operation-status"
          data-status={status}
        >
          {summary}
        </p>
        {status !== 'dismissed' && <OperationList operation={verb} items={items} results={proposal.results} />}
        {overtaken && (
          <p className="card-caption text-muted-foreground" data-testid="file-operation-overtaken">
            {t('cards.fileOperationProposal.live.overtaken')}
          </p>
        )}
        {proposal.decidedAt && (
          <p className="card-caption text-muted-foreground" data-testid="file-operation-decided-by">
            {t(`cards.fileOperationProposal.live.decidedBy.${status}`, {
              name: proposal.decidedByName ?? t('cards.fileOperationProposal.live.someone'),
              when: formatAbsoluteTime(proposal.decidedAt, locale),
            })}
          </p>
        )}
      </ProposalShell>
    )
  }

  const shownNote = proposal ? proposal.payload.note : note
  return (
    <ProposalShell tone={tone}>
      <SectionLabel icon={FolderTree}>{t(`cards.fileOperationProposal.eyebrow.${verb}`)}</SectionLabel>

      <p className="text-foreground text-sm font-semibold">{title}</p>

      <OperationList operation={verb} items={items} />

      {shownNote && <p className="card-caption text-muted-foreground">{shownNote}</p>}

      {/* Why there is nothing to press, stated where the buttons would be:
          the object could not be read, or the server says this reader may not
          decide it (no write access to the project). */}
      {loadFailed && (
        <p className="card-caption text-muted-foreground" data-testid="file-operation-unavailable">
          {t('cards.fileOperationProposal.live.loadError')}
        </p>
      )}
      {proposal && !proposal.canDecide && (
        <p className="card-caption text-muted-foreground" data-testid="file-operation-unavailable">
          {t('cards.fileOperationProposal.live.readOnly')}
        </p>
      )}

      {error && <p className="text-destructive text-sm">{error}</p>}

      {proposal?.canDecide && (
        <div className="flex flex-wrap items-center justify-end gap-2">
          <p className="text-muted-foreground mr-auto text-sm">{t('cards.fileOperationProposal.prompt')}</p>
          <Button
            type="button"
            size="sm"
            onClick={() => void decide('apply')}
            aria-disabled={busy !== null || undefined}
            aria-busy={busy === 'apply' || undefined}
            className="aria-disabled:cursor-default"
          >
            <StackedLabel
              busy={busy === 'apply'}
              idle={t('cards.fileOperationProposal.accept')}
              working={t('cards.fileOperationProposal.applying')}
            />
          </Button>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => void decide('dismiss')}
            aria-disabled={busy !== null || undefined}
            aria-busy={busy === 'dismiss' || undefined}
            className="aria-disabled:cursor-default aria-disabled:opacity-50"
          >
            {t('cards.fileOperationProposal.reject')}
          </Button>
        </div>
      )}
    </ProposalShell>
  )
}

/** The older contract: Accept runs the operations from the browser and the decision lives on the message. */
function BrowserAppliedCard({
  title,
  operation,
  operations,
  note,
  messageId,
  cardKey,
  decisionsMustPersist,
}: Omit<FileOperationProposalCardProps, 'proposalId'>) {
  const t = useTranslations('chat')
  const projectId = useChatStore((s) => s.projectId)
  const { decision, decide, canDecide } = useCardDecision(messageId, cardKey, {
    mustPersist: decisionsMustPersist,
  })
  const [results, setResults] = useState<FileOperationResult[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [isSubmitting, setIsSubmitting] = useState(false)

  // Why this card cannot be applied here, if it cannot. STATED rather than
  // drawn as an absence: a card that shows a proposal and offers nothing, with
  // no line saying why, reads as one that failed to load. One case is left —
  // every route behind this card is project-scoped, and a chat can have no
  // project.
  const unavailable = projectId ? undefined : ('noProject' as const)
  const failed = results?.filter((result) => !result.ok) ?? []

  // The decision the rows are announcing, recorded after the beat. Held in a
  // ref so an unmount during the beat records it at once instead of dropping
  // it: the writes have happened, and a reload must not offer them again.
  const pendingDecision = useRef<(() => void) | null>(null)
  useEffect(
    () => () => {
      pendingDecision.current?.()
    },
    []
  )

  const accept = async () => {
    if (!projectId || isSubmitting) return
    setError(null)
    setIsSubmitting(true)
    try {
      const applied = await applyFileOperations(operation, operations, projectId)
      setResults(applied)
      const failures = applied.filter((result) => !result.ok).length
      if (failures === applied.length) {
        // Nothing was applied, so nothing was decided: the card stays pending
        // and the reader can press again once the cause is gone.
        setIsSubmitting(false)
        setError(t('cards.fileOperationProposal.error'))
        return
      }
      const record = (): void => {
        pendingDecision.current = null
        decide(failures > 0 ? 'partiallyApplied' : 'accepted')
        setIsSubmitting(false)
      }
      pendingDecision.current = record
      window.setTimeout(() => pendingDecision.current?.(), ROW_BEAT_MS)
    } catch {
      setIsSubmitting(false)
      setError(t('cards.fileOperationProposal.error'))
    }
  }

  if (decision === 'accepted' || decision === 'partiallyApplied') {
    return (
      <ProposalShell tone="accepted">
        <p className="text-foreground text-sm">
          {decision === 'accepted'
            ? t(`cards.fileOperationProposal.applied.${operation}`, { count: operations.length })
            : t('cards.fileOperationProposal.partial')}
        </p>
        {failed.length > 0 && (
          <ul className="flex flex-col gap-1" data-testid="file-operation-failures">
            {failed.map((result, index) => (
              <li key={`${result.label}-${index}`} className="card-caption text-muted-foreground">
                {result.label} — {result.reason}
              </li>
            ))}
          </ul>
        )}
      </ProposalShell>
    )
  }

  if (decision === 'rejected') {
    return (
      <ProposalShell tone="dismissed">
        <p className="text-muted-foreground text-sm">
          {t('cards.fileOperationProposal.dismissed')}
        </p>
      </ProposalShell>
    )
  }

  return (
    <ProposalShell tone="pending">
      <SectionLabel icon={FolderTree}>
        {t(`cards.fileOperationProposal.eyebrow.${operation}`)}
      </SectionLabel>

      <p className="text-foreground text-sm font-semibold">{title}</p>

      <OperationList operation={operation} items={operations} results={results} />

      {note && <p className="card-caption text-muted-foreground">{note}</p>}

      {/* A chat with no project. The proposal still READS, and the reason
          stands where the buttons would be, so the card is unavailable rather
          than broken. */}
      {unavailable && (
        <p className="card-caption text-muted-foreground" data-testid="file-operation-unavailable">
          {t(`cards.fileOperationProposal.unavailable.${unavailable}`)}
        </p>
      )}

      {error && <p className="text-destructive text-sm">{error}</p>}

      {/* Nothing to press where the answer could not be kept (`canDecide`) or
          where there is nothing to press it against (`unavailable`, which
          includes a chat with no project: every route behind this card is
          project-scoped).

          `flex-wrap` on the row is not decoration: at 390px „Übernehmen?" and
          the two buttons do not fit on one line, and a non-wrapping row put the
          question UNDER the primary button — the one place a reader must be
          able to read what they are answering. Wrapped, the question takes its
          own line and the pair stays right-aligned beneath it. */}
      {canDecide && !unavailable && (
        <div className="flex flex-wrap items-center justify-end gap-2">
          <p className="text-muted-foreground mr-auto text-sm">
            {t('cards.fileOperationProposal.prompt')}
          </p>
          <Button
            type="button"
            size="sm"
            onClick={() => void accept()}
            aria-disabled={isSubmitting || undefined}
            aria-busy={isSubmitting || undefined}
            className="aria-disabled:cursor-default"
          >
            <StackedLabel
              busy={isSubmitting}
              idle={t('cards.fileOperationProposal.accept')}
              working={t('cards.fileOperationProposal.applying')}
            />
          </Button>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => {
              if (isSubmitting) return
              setError(null)
              decide('rejected')
            }}
            aria-disabled={isSubmitting || undefined}
            className="aria-disabled:cursor-default aria-disabled:opacity-50"
          >
            {t('cards.fileOperationProposal.reject')}
          </Button>
        </div>
      )}
    </ProposalShell>
  )
}
