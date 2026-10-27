'use client'

/**
 * Platform → Feedback: every report members sent, across organizations, and
 * the one control that matters for each — where it is in triage.
 *
 * Triage lives in PostHog Support. The server opens a ticket for every report,
 * and the status shown and set here is that ticket's, read live and named as
 * PostHog names it (`new`, `open`, `pending`, `on_hold`, `resolved`); each row
 * links to its ticket. When PostHog cannot be read, or Support is not
 * configured, the list is the local log (`source: 'local'`): read-only, no
 * status filter, and an alert says where statuses are managed. Reports whose
 * ticket failed to open are listed apart ("not in PostHog yet"), so nothing a
 * member sent is out of sight.
 *
 * The page opens on the active support cases: every ticket that is not
 * resolved, whoever has it, because the question an owner arrives with is
 * "what is still open, who has it, and are we the ones who owe an answer?".
 * Each row says who the ticket is assigned to, when something last happened on
 * it and whose move it is, and offers „Übernehmen" (assign it to the reader in
 * PostHog) when it is not the reader's yet. A second chip row narrows to the
 * reader's own tickets or the unassigned ones; „Alle" and „Erledigt" bring the
 * resolved back. Answering stays in PostHog: the row links its ticket there.
 * An inbox row lands here with `?report=<id>`; that report is
 * pinned to the top and marked, whatever the filter says, so the link always
 * shows what it promised. A link to a report that no longer exists (or that
 * this reader cannot see) says so, instead of silently showing the list.
 *
 * Filters refetch, and a slow answer for the previous filter must not land on
 * top of the current one: only the newest request writes. While a refetch is
 * in flight the rows on screen stay, marked busy, rather than blinking out.
 */

import type { JSX } from 'react'
import * as React from 'react'
import {
  ChevronDown,
  CloudOff,
  ExternalLink,
  Inbox,
  Mail,
  MessageSquarePlus,
  SearchX,
  UserRound,
  UserRoundX,
} from 'lucide-react'
import { toast } from 'sonner'

import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Chip, ChipCount } from '@/components/ui/chip'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import { EmptyState } from '@/components/ui/empty-state'
import { SectionLabel } from '@/components/ui/section-label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { TimeAgo } from '@/components/ui/time-ago'
import { SectionCard } from '@/features/platform/components/section-card'
import { useLocale, useTranslations } from '@/i18n'
import {
  fetchPlatformFeedback,
  fetchPlatformFeedbackReport,
  triagePlatformFeedback,
  claimPlatformFeedbackTicket,
  type ListFeedbackFilters,
} from '@/lib/product-feedback/client'
import {
  ACTIVE_SUPPORT_TICKET_STATUSES,
  PRODUCT_FEEDBACK_KINDS,
  SUPPORT_TICKET_STATUSES,
  type ProductFeedbackAssigneeFilter,
  type ProductFeedbackKind,
  type ProductFeedbackListResponse,
  type ProductFeedbackReportView,
  type ProductFeedbackStatusFilter,
  type ProductFeedbackTicketView,
  type SupportTicketStatus,
} from '@/lib/product-feedback/types'
import { cn } from '@/lib/utils'
import { FEEDBACK_KIND_ICONS } from './feedback-form'

export interface FeedbackTriageClient {
  list: (filters: ListFeedbackFilters) => Promise<ProductFeedbackListResponse>
  get: (id: string) => Promise<ProductFeedbackReportView | null>
  triage: (id: string, status: SupportTicketStatus) => Promise<ProductFeedbackReportView>
  /** Assign a ticket to the reader in PostHog (the Slack alert's „Übernehmen"). */
  claim?: (ticketId: string) => Promise<ProductFeedbackReportView>
}

const defaultClient: FeedbackTriageClient = {
  list: fetchPlatformFeedback,
  get: fetchPlatformFeedbackReport,
  triage: triagePlatformFeedback,
  claim: claimPlatformFeedbackTicket,
}

const STATUS_CHIP: Record<SupportTicketStatus, 'info' | 'warning' | 'default' | 'success' | 'muted'> = {
  new: 'info',
  open: 'warning',
  pending: 'default',
  on_hold: 'muted',
  resolved: 'success',
}

const KIND_CHIP: Record<ProductFeedbackKind, 'destructive' | 'default' | 'success' | 'secondary'> =
  {
    bug: 'destructive',
    idea: 'default',
    praise: 'success',
    question: 'secondary',
  }

type StatusFilter = ProductFeedbackStatusFilter | 'all'
type KindFilter = ProductFeedbackKind | 'all'
type AssigneeFilter = ProductFeedbackAssigneeFilter | 'all'

const ASSIGNEE_FILTERS: readonly AssigneeFilter[] = ['all', 'mine', 'unassigned']

/** A ticket the reader can take: still open, and not theirs already. */
function claimable(ticket: ProductFeedbackTicketView): boolean {
  return ticket.status !== 'resolved' && !ticket.assignee?.isViewer
}

export interface FeedbackTriageProps {
  /** Whether the reader holds the manage permission; view-only otherwise. */
  canTriage: boolean
  /** The report an inbox row linked to, pinned and marked. */
  focusReportId?: string | null
  /**
   * A ticket to take on arrival: the Slack alert's „Übernehmen" button lands
   * with `?claim=<ticket id>`. The ticket is assigned to the reader in PostHog
   * and its report pinned like a linked one.
   */
  claimTicketId?: string | null
  client?: FeedbackTriageClient
}

export function FeedbackTriage({
  canTriage,
  focusReportId = null,
  claimTicketId = null,
  client = defaultClient,
}: FeedbackTriageProps): JSX.Element {
  const t = useTranslations('feedback')
  const [status, setStatus] = React.useState<StatusFilter>('active')
  const [kind, setKind] = React.useState<KindFilter>('all')
  const [assignee, setAssignee] = React.useState<AssigneeFilter>('all')
  const [data, setData] = React.useState<ProductFeedbackListResponse | null>(null)
  const [focused, setFocused] = React.useState<ProductFeedbackReportView | null>(null)
  /** The linked report could not be found (deleted, or not visible to this reader). */
  const [focusMissing, setFocusMissing] = React.useState(false)
  const [loading, setLoading] = React.useState(true)
  const [loadingMore, setLoadingMore] = React.useState(false)
  const [error, setError] = React.useState(false)
  const [busyId, setBusyId] = React.useState<string | null>(null)
  const [claimingId, setClaimingId] = React.useState<string | null>(null)
  // Only the newest list request may write: switching filters quickly must
  // not let the answer for the previous filter overwrite the current one.
  const requestId = React.useRef(0)

  const filters = React.useMemo<ListFeedbackFilters>(
    () => ({
      status: status === 'all' ? undefined : status,
      kind: kind === 'all' ? undefined : kind,
      assignee: assignee === 'all' ? undefined : assignee,
    }),
    [status, kind, assignee]
  )

  const load = React.useCallback(async () => {
    const id = ++requestId.current
    setLoading(true)
    setError(false)
    try {
      const next = await client.list(filters)
      if (id === requestId.current) setData(next)
    } catch {
      if (id === requestId.current) setError(true)
    } finally {
      if (id === requestId.current) setLoading(false)
    }
  }, [client, filters])

  React.useEffect(() => {
    void load()
  }, [load])

  React.useEffect(() => {
    if (!focusReportId) return
    let cancelled = false
    setFocusMissing(false)
    client
      .get(focusReportId)
      .then((report) => {
        if (cancelled) return
        setFocused(report)
        setFocusMissing(report === null)
      })
      .catch(() => {
        if (!cancelled) setFocusMissing(true)
      })
    return () => {
      cancelled = true
    }
  }, [client, focusReportId])

  React.useEffect(() => {
    if (!claimTicketId || !canTriage || !client.claim) return
    let cancelled = false
    client
      .claim(claimTicketId)
      .then((report) => {
        if (cancelled) return
        setFocused(report)
        setFocusMissing(false)
        toast.success(
          report.ticket?.number
            ? t('platform.claimed', { number: report.ticket.number })
            : t('platform.claimedUnnumbered')
        )
      })
      .catch(() => {
        if (!cancelled) toast.error(t('platform.claimError'))
      })
    return () => {
      cancelled = true
    }
  }, [client, claimTicketId, canTriage, t])

  async function loadMore(): Promise<void> {
    if (!data?.nextCursor) return
    const id = requestId.current
    setLoadingMore(true)
    try {
      const next = await client.list({ ...filters, cursor: data.nextCursor })
      // A filter change while the page was loading made this page stale.
      if (id !== requestId.current) return
      setData((current) =>
        // The unticketed reports belong to the first page; later pages only add tickets.
        current
          ? { ...next, reports: [...current.reports, ...next.reports], unticketed: current.unticketed }
          : next
      )
    } catch {
      toast.error(t('platform.loadError'))
    } finally {
      setLoadingMore(false)
    }
  }

  async function changeStatus(
    report: ProductFeedbackReportView,
    next: SupportTicketStatus
  ): Promise<void> {
    const previous = report.ticket?.status
    if (!previous || next === previous) return
    setBusyId(report.id)
    try {
      const updated = await client.triage(report.id, next)
      setFocused((current) => (current?.id === updated.id ? updated : current))
      setData((current) =>
        current
          ? {
              ...current,
              reports: current.reports.map((row) => (row.id === updated.id ? updated : row)),
              counts: current.counts && {
                ...current.counts,
                [previous]: Math.max(0, current.counts[previous] - 1),
                [next]: current.counts[next] + 1,
              },
            }
          : current
      )
      toast.success(t('platform.triaged', { status: t(`statuses.${next}`) }))
    } catch {
      toast.error(t('platform.triageError'))
    } finally {
      setBusyId(null)
    }
  }

  /** Take a row's ticket: PostHog assigns it to the reader, and the row shows it. */
  async function claimRow(report: ProductFeedbackReportView): Promise<void> {
    const ticketId = report.ticket?.id
    if (!ticketId || !client.claim) return
    setClaimingId(report.id)
    try {
      const updated = await client.claim(ticketId)
      setFocused((current) => (current?.id === updated.id ? updated : current))
      setData((current) =>
        current
          ? { ...current, reports: current.reports.map((row) => (row.id === updated.id ? updated : row)) }
          : current
      )
      toast.success(
        updated.ticket?.number
          ? t('platform.claimed', { number: updated.ticket.number })
          : t('platform.claimedUnnumbered')
      )
    } catch {
      toast.error(t('platform.claimError'))
    } finally {
      setClaimingId(null)
    }
  }

  const reports = (data?.reports ?? []).filter((report) => report.id !== focused?.id)
  const unticketed = (data?.unticketed ?? []).filter((report) => report.id !== focused?.id)
  const counts = data?.counts ?? null
  const total = counts ? Object.values(counts).reduce((sum, value) => sum + value, 0) : undefined
  const active = counts
    ? ACTIVE_SUPPORT_TICKET_STATUSES.reduce((sum, option) => sum + counts[option], 0)
    : undefined
  const canClaim = canTriage && Boolean(client.claim)
  // The local log has no triage state: the status filter would be a lie there.
  const local = data?.source === 'local'
  const live = data?.source === 'posthog'
  const nothingShown = !focused && reports.length === 0

  return (
    <SectionCard
      title={t('platform.listTitle')}
      loading={loading && !data}
      refreshing={loading && data !== null}
      error={error && !data}
      errorMessage={t('platform.loadError')}
      onRetry={() => void load()}
      testId="feedback-triage"
      action={
        <Select value={kind} onValueChange={(value) => setKind(value as KindFilter)}>
          <SelectTrigger size="sm" aria-label={t('platform.filters.kindLabel')} className="w-40">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">{t('platform.filters.allKinds')}</SelectItem>
            {PRODUCT_FEEDBACK_KINDS.map((option) => (
              <SelectItem key={option} value={option}>
                {t(`kinds.${option}.label`)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      }
    >
      <div className="flex flex-col gap-4">
        {local ? (
          <Alert variant="info" data-testid="feedback-local-source">
            <CloudOff aria-hidden />
            <AlertTitle className="line-clamp-none">{t('platform.localSource.title')}</AlertTitle>
            <AlertDescription>{t('platform.localSource.description')}</AlertDescription>
          </Alert>
        ) : (
          <div className="flex flex-col gap-2">
            <div
              role="group"
              aria-label={t('platform.filters.label')}
              className="flex flex-wrap gap-1.5"
            >
              <StatusFilterChip
                active={status === 'active'}
                onClick={() => setStatus('active')}
                count={active}
              >
                {t('platform.filters.active')}
              </StatusFilterChip>
              {SUPPORT_TICKET_STATUSES.map((option) => (
                <StatusFilterChip
                  key={option}
                  active={status === option}
                  onClick={() => setStatus(option)}
                  count={counts?.[option]}
                >
                  {t(`statuses.${option}`)}
                </StatusFilterChip>
              ))}
              <StatusFilterChip
                active={status === 'all'}
                onClick={() => setStatus('all')}
                count={total}
              >
                {t('platform.filters.all')}
              </StatusFilterChip>
            </div>
            <div
              role="group"
              aria-label={t('platform.filters.assigneeLabel')}
              className="flex flex-wrap gap-1.5"
            >
              {ASSIGNEE_FILTERS.map((option) => (
                <StatusFilterChip
                  key={option}
                  active={assignee === option}
                  onClick={() => setAssignee(option)}
                >
                  {t(`platform.filters.assignees.${option}`)}
                </StatusFilterChip>
              ))}
            </div>
          </div>
        )}

        {data?.viewerNotInPosthog ? (
          <Alert variant="info" data-testid="feedback-viewer-not-in-posthog">
            <UserRoundX aria-hidden />
            <AlertTitle className="line-clamp-none">{t('platform.viewerNotInPosthog.title')}</AlertTitle>
            <AlertDescription>{t('platform.viewerNotInPosthog.description')}</AlertDescription>
          </Alert>
        ) : null}

        {focusMissing ? (
          <Alert variant="warning" data-testid="feedback-focus-missing">
            <SearchX aria-hidden />
            <AlertTitle className="line-clamp-none">{t('platform.focusMissing.title')}</AlertTitle>
            <AlertDescription>{t('platform.focusMissing.description')}</AlertDescription>
          </Alert>
        ) : null}

        {/* A refetch that failed keeps the rows it had and says so here; only a
            first load with nothing to show becomes the card's error state. */}
        {error && data ? (
          <Alert variant="destructive">
            <AlertDescription>
              <p>{t('platform.loadError')}</p>
              <Button variant="outline" size="sm" onClick={() => void load()}>
                {t('platform.retry')}
              </Button>
            </AlertDescription>
          </Alert>
        ) : null}

        {/* The filters stay above an empty result: an empty "New" queue is
            the normal state, and the way out of it is the chip next to it. */}
        {nothingShown ? (
          <EmptyState
            variant="bare"
            icon={MessageSquarePlus}
            title={t('platform.empty.title')}
            description={t('platform.empty.description')}
          />
        ) : (
          <ul className="flex flex-col divide-y" aria-busy={loading || undefined}>
            {focused && (
              <ReportRow
                report={focused}
                focused
                canTriage={canTriage && live}
                busy={busyId === focused.id}
                onStatusChange={(next) => void changeStatus(focused, next)}
                canClaim={canClaim && live}
                claiming={claimingId === focused.id}
                onClaim={() => void claimRow(focused)}
              />
            )}
            {reports.map((report) => (
              <ReportRow
                key={report.id}
                report={report}
                canTriage={canTriage && live}
                busy={busyId === report.id}
                onStatusChange={(next) => void changeStatus(report, next)}
                canClaim={canClaim && live}
                claiming={claimingId === report.id}
                onClaim={() => void claimRow(report)}
              />
            ))}
          </ul>
        )}

        {unticketed.length > 0 ? (
          <section
            aria-labelledby="feedback-unticketed-title"
            data-testid="feedback-unticketed"
            className="flex flex-col gap-1 border-t pt-4"
          >
            <SectionLabel as="h3" id="feedback-unticketed-title">
              {t('platform.unticketed.title')}
            </SectionLabel>
            <p className="text-muted-foreground text-xs">{t('platform.unticketed.description')}</p>
            <ul className="flex flex-col divide-y">
              {unticketed.map((report) => (
                <ReportRow
                  key={report.id}
                  report={report}
                  canTriage={false}
                  busy={false}
                  onStatusChange={() => undefined}
                />
              ))}
            </ul>
          </section>
        ) : null}

        {data?.nextCursor && (
          <Button
            variant="outline"
            onClick={() => void loadMore()}
            loading={loadingMore}
            className="self-center"
          >
            {t('platform.loadMore')}
          </Button>
        )}
      </div>
    </SectionCard>
  )
}

function StatusFilterChip({
  active,
  onClick,
  count,
  children,
}: {
  active: boolean
  onClick: () => void
  /** Absent until the PostHog counts are known. */
  count?: number
  children: React.ReactNode
}): JSX.Element {
  return (
    <Chip asChild interactive variant={active ? 'default' : 'outline'}>
      <button type="button" aria-pressed={active} onClick={onClick}>
        {children}
        {count === undefined ? null : <ChipCount count={count} />}
      </button>
    </Chip>
  )
}

/** A text link that leaves Piloti (PostHog), styled like the row's mail link. */
function ExternalTextLink({
  href,
  testId,
  children,
}: {
  href: string
  testId: string
  children: React.ReactNode
}): JSX.Element {
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      data-testid={testId}
      className="text-primary pointer-coarse:min-h-11 inline-flex items-center gap-1 hover:underline"
    >
      <ExternalLink className="size-3.5" aria-hidden />
      {children}
    </a>
  )
}

function ReportRow({
  report,
  focused = false,
  canTriage,
  busy,
  onStatusChange,
  canClaim = false,
  claiming = false,
  onClaim,
}: {
  report: ProductFeedbackReportView
  focused?: boolean
  /** Whether the status select shows: the reader may triage and the list is PostHog's. */
  canTriage: boolean
  busy: boolean
  onStatusChange: (status: SupportTicketStatus) => void
  /** Whether „Übernehmen" may show: the reader may triage and the list is PostHog's. */
  canClaim?: boolean
  claiming?: boolean
  onClaim?: () => void
}): JSX.Element {
  const t = useTranslations('feedback')
  const { locale } = useLocale()
  const ref = React.useRef<HTMLLIElement>(null)
  const KindIcon = FEEDBACK_KIND_ICONS[report.kind]
  const { ticket } = report

  React.useEffect(() => {
    if (focused) ref.current?.scrollIntoView({ block: 'nearest' })
  }, [focused])

  const reporter = report.reporter.name ?? report.reporter.email ?? t('platform.unknownReporter')
  const organization = report.organizationName ?? t('platform.unknownOrganization')

  return (
    <li
      ref={ref}
      data-testid="feedback-report"
      data-report-id={report.id}
      data-focused={focused || undefined}
      className={cn('flex flex-col gap-3 py-4', focused && 'bg-muted/50 -mx-6 px-6')}
    >
      <div className="flex flex-wrap items-center gap-2">
        {focused ? (
          <Badge variant="outline" className="font-normal">
            <Inbox aria-hidden />
            {t('platform.linked')}
          </Badge>
        ) : null}
        {ticket?.number != null ? (
          <span className="text-foreground font-mono text-xs" data-testid="feedback-ticket-number">
            #{ticket.number}
          </span>
        ) : null}
        <Chip variant={KIND_CHIP[report.kind]} size="sm">
          <KindIcon aria-hidden />
          {t(`kinds.${report.kind}.label`)}
        </Chip>
        <span className="text-muted-foreground min-w-0 truncate text-xs">
          {t('platform.from', { name: reporter, organization })}
        </span>
        <TimeAgo
          date={report.createdAt}
          locale={locale}
          className="text-muted-foreground text-xs"
        />
        {ticket ? (
          <div className="ml-auto">
            {canTriage ? (
              <Select
                value={ticket.status}
                onValueChange={(value) => onStatusChange(value as SupportTicketStatus)}
                disabled={busy}
              >
                <SelectTrigger size="sm" aria-label={t('platform.statusLabel')} className="w-44">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {SUPPORT_TICKET_STATUSES.map((option) => (
                    <SelectItem key={option} value={option}>
                      {t(`statuses.${option}`)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            ) : (
              <Chip variant={STATUS_CHIP[ticket.status]} size="sm">
                {t(`statuses.${ticket.status}`)}
              </Chip>
            )}
          </div>
        ) : null}
      </div>

      {/* The list reads as a queue: a few lines say which report it is, and the
          linked report shows in full. */}
      <p
        className={cn(
          'text-foreground whitespace-pre-wrap break-words text-sm leading-relaxed',
          !focused && 'line-clamp-3'
        )}
      >
        {report.message}
      </p>

      {ticket ? (
        <CaseLine
          ticket={ticket}
          canClaim={canClaim && claimable(ticket)}
          claiming={claiming}
          onClaim={onClaim}
        />
      ) : null}

      <div className="text-muted-foreground flex flex-wrap items-center gap-x-4 gap-y-1 text-xs">
        {report.pagePath && (
          <span className="font-mono">{t('platform.onPage', { page: report.pagePath })}</span>
        )}
        {report.reporter.email ? (
          <a
            href={`mailto:${report.reporter.email}`}
            className="text-primary pointer-coarse:min-h-11 inline-flex items-center gap-1 hover:underline"
          >
            <Mail className="size-3.5" aria-hidden />
            {t('platform.contact')}
          </a>
        ) : (
          <span>{t('platform.noContact')}</span>
        )}
        {ticket ? (
          <ExternalTextLink href={ticket.url} testId="feedback-ticket-link">
            {t('platform.openInPosthog')}
          </ExternalTextLink>
        ) : report.posthogPersonUrl ? (
          <ExternalTextLink href={report.posthogPersonUrl} testId="feedback-recordings-link">
            {t('platform.recordingsLink')}
          </ExternalTextLink>
        ) : null}
      </div>

      {(report.context.userAgent || report.context.viewport) && (
        <Collapsible>
          <CollapsibleTrigger className="text-muted-foreground hover:text-foreground pointer-coarse:min-h-11 group inline-flex items-center gap-1 text-xs">
            {t('platform.details')}
            <ChevronDown
              aria-hidden
              className="duration-quick size-3.5 transition-transform group-data-[state=open]:rotate-180 motion-reduce:transition-none"
            />
          </CollapsibleTrigger>
          <CollapsibleContent>
            <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs">
              {(
                [
                  [t('dialog.context.browser'), report.context.userAgent],
                  [t('dialog.context.screen'), report.context.viewport],
                  [t('dialog.context.locale'), report.context.locale],
                  [t('dialog.context.timeZone'), report.context.timeZone],
                ] as const
              )
                .filter(([, value]) => Boolean(value))
                .map(([label, value]) => (
                  <React.Fragment key={label}>
                    <dt className="text-muted-foreground">{label}</dt>
                    <dd className="min-w-0 break-words">{value}</dd>
                  </React.Fragment>
                ))}
            </dl>
          </CollapsibleContent>
        </Collapsible>
      )}
    </li>
  )
}

/**
 * The case on one row: who has the ticket, whose move it is, when something
 * last happened, and „Übernehmen" when the reader can take it.
 */
function CaseLine({
  ticket,
  canClaim,
  claiming,
  onClaim,
}: {
  ticket: ProductFeedbackTicketView
  canClaim: boolean
  claiming: boolean
  onClaim?: () => void
}): JSX.Element {
  const t = useTranslations('feedback')
  const { locale } = useLocale()
  const { assignee } = ticket
  const holder = !assignee
    ? t('platform.case.unassigned')
    : assignee.isViewer
      ? t('platform.case.assignedToYou')
      : t('platform.case.assignedTo', {
          name: assignee.name ?? assignee.email ?? t('platform.case.unnamedAssignee'),
        })
  const HolderIcon = assignee ? UserRound : UserRoundX

  return (
    <div
      data-testid="feedback-case"
      className="text-muted-foreground flex flex-wrap items-center gap-x-4 gap-y-2 text-xs"
    >
      <span
        data-testid="feedback-assignee"
        className={cn('inline-flex min-w-0 items-center gap-1', !assignee && 'text-foreground')}
      >
        <HolderIcon className="size-3.5 shrink-0" aria-hidden />
        <span className="truncate">{holder}</span>
      </span>
      {ticket.awaiting ? (
        <Chip
          size="sm"
          variant={ticket.awaiting === 'team' ? 'warning' : 'muted'}
          data-testid="feedback-awaiting"
          data-awaiting={ticket.awaiting}
        >
          {t(`platform.case.awaiting.${ticket.awaiting}`)}
        </Chip>
      ) : null}
      <span className="inline-flex items-center gap-1">
        {t('platform.case.lastActivity')}
        <TimeAgo date={ticket.lastActivityAt} locale={locale} />
      </span>
      {canClaim && onClaim ? (
        <Button
          variant="outline"
          size="sm"
          className="ml-auto"
          loading={claiming}
          onClick={onClaim}
          data-testid="feedback-claim"
        >
          {t('platform.case.claim')}
        </Button>
      ) : null}
    </div>
  )
}
