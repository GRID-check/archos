/**
 * Product feedback — submission by any member, triage by the platform.
 *
 * Owns authorization for both halves (ADR-0017): the routes are thin adapters.
 *
 *   - Submitting needs nothing but a signed-in member: telling us about a bug
 *     must not depend on a feature flag or a role.
 *   - Reading and triaging are platform surfaces and ask for the specific
 *     `platform:*` permission each needs, here as well as on the route, so a
 *     second caller cannot lose the gate.
 *
 * Triage is PostHog Support's (ADR-0118). Every report opens a ticket from
 * here, and the platform page reads and moves that ticket; this module keeps
 * no status of its own. The local row is the intake log: the page joins it to
 * the tickets for the words and the reporter, and lists it alone, read-only,
 * while Support is not configured or PostHog cannot be read.
 *
 * Submission is bounded by the route's `FEEDBACK_REPORT_LIMIT` rather than by
 * anything here: every report becomes an inbox item per platform owner, so the
 * budget is per person and far below the default mutation budget.
 */

import 'server-only'
import { randomUUID } from 'node:crypto'
import { ConflictError, NotFoundError, UpstreamError } from '@/lib/api/errors'
import type { AuthorizedSession, GridSession } from '@/lib/auth/types'
import { PLATFORM_PERMISSIONS } from '@/lib/authz/permissions'
import { requirePlatformPermission } from '@/lib/authz/platform'
import type { ProductFeedback } from '@/lib/db/schema'
import { withPlatformAccess } from '@/lib/db/tenant-context'
import { captureServer } from '@/lib/analytics/posthog-server'
import { getOrganizationDisplayName } from '@/lib/organizations/service'
import { getOrganizationDisplayNames } from '@/lib/organizations/display-names'
import {
  assignSupportTicket,
  countFeedbackTicketsByStatus,
  findPosthogUserIdByEmail,
  getSupportTicket,
  lastVisibleMessageAuthor,
  listCustomerVisibleMessages,
  listFeedbackTickets,
  listFeedbackTicketsOf,
  listPosthogMembers,
  memberByEmail,
  openFeedbackTicket,
  replyAsCustomer,
  updateSupportTicketStatus,
  type SupportTicketAssigneeFilter,
} from '@/lib/posthog-support/client'
import { posthogSupportConfigFromEnv } from '@/lib/posthog-support/config'
import {
  ACTIVE_SUPPORT_TICKET_STATUSES,
  FEEDBACK_TICKET_TAG,
  kindTicketTag,
  NO_CONTACT_TICKET_TAG,
  originTicketTag,
  PosthogSupportUnavailableError,
  SUPPORT_TICKET_STATUSES,
  type PosthogMember,
  type PosthogSupportConfig,
  type SupportMessage,
  type SupportTicket,
  type SupportTicketStatus,
} from '@/lib/posthog-support/types'
import { maskChatText } from '@/lib/upload-screening/service'
import { announceProductFeedback } from './announce'
import {
  getOwnProductFeedback,
  getProductFeedback,
  getProductFeedbackByTicketIds,
  insertProductFeedback,
  listOwnProductFeedback,
  listProductFeedback,
  markOwnProductFeedbackSeen,
  OWN_PRODUCT_FEEDBACK_LIMIT,
  PRODUCT_FEEDBACK_LIST_LIMIT,
  setProductFeedbackTicket,
  type ProductFeedbackRow,
} from './repository'
import type {
  ListOwnProductFeedbackQuery,
  ListProductFeedbackQuery,
  OwnProductFeedbackListResponse,
  OwnProductFeedbackMessage,
  OwnProductFeedbackSummary,
  OwnProductFeedbackThread,
  ProductFeedbackAssigneeView,
  ProductFeedbackAwaiting,
  ProductFeedbackKind,
  ProductFeedbackListResponse,
  ProductFeedbackReportView,
  ProductFeedbackTicketView,
  SubmitProductFeedbackInput,
  SubmittedProductFeedbackView,
} from './types'

/** How far back the page looks for reports whose ticket never opened. */
const UNTICKETED_WINDOW_DAYS = 30

/** Support settings for this deployment, `null` while it has none. */
const supportConfig = (): PosthogSupportConfig | null => posthogSupportConfigFromEnv(process.env)

/**
 * The first message of a report's Support ticket: the kind, the report id (the
 * key back to the local row), the page, then the masked text.
 */
export function supportTicketText(
  kind: ProductFeedbackKind,
  reportId: string,
  pagePath: string | null,
  maskedText: string
): string {
  return `[${kind}] #${reportId}${pagePath ? ` ${pagePath}` : ''}\n${maskedText}`
}

/**
 * Tell the support automation in PostHog that a ticket opened or its reporter
 * answered. PostHog's own ticket events cannot say which deployment the ticket
 * came from (staging and production share one project); this event carries
 * `app_host` like every server event, so the Slack alert links the „Übernehmen"
 * button to the deployment that holds the report. Ids and the kind only: the
 * alert reads the member's words from the ticket itself
 * (`deploy/posthog/support/slack-alert.hog`). Fire-and-forget.
 */
function announceToSupport(
  event: 'product_feedback_ticket_opened' | 'product_feedback_reply_sent',
  session: AuthorizedSession,
  report: ProductFeedback,
  ticketId: string
): void {
  captureServer({
    event,
    distinctId: session.userId,
    organizationId: session.organizationId,
    properties: {
      ticket_id: ticketId,
      report_id: report.id,
      kind: report.kind,
      allow_contact: report.allowContact,
    },
  })
}

/**
 * The tags a report's ticket carries: the feedback tag, its kind, `no-contact`
 * when the reporter declined contact, and the deployment it came from, which
 * the PostHog workflow reads to know whom to tell about a team reply.
 */
export function ticketTagsFor(
  report: Pick<ProductFeedback, 'kind' | 'allowContact'>,
  config: Pick<PosthogSupportConfig, 'appOrigin'>
): string[] {
  const origin = originTicketTag(config.appOrigin)
  return [
    FEEDBACK_TICKET_TAG,
    kindTicketTag(report.kind),
    ...(report.allowContact ? [] : [NO_CONTACT_TICKET_TAG]),
    ...(origin ? [origin] : []),
  ]
}

/**
 * Open the report's Support ticket and remember its id. Every report gets one,
 * a reporter who declined contact too (tagged so nobody replies). The words go
 * out masked against the office's „Sensible Daten" policy (ADR-0086), and when
 * the policy cannot be read no ticket opens: never the unmasked text. Fails
 * open: the report is stored already, and the platform page lists a report
 * without a ticket as not in PostHog yet.
 */
async function openTicketFor(
  session: AuthorizedSession,
  report: ProductFeedback,
  input: SubmitProductFeedbackInput,
  config: PosthogSupportConfig
): Promise<void> {
  try {
    const masked = (await maskChatText(session.organizationId, input.message)).text
    // A session of the report's own: the reporter's replies must come from it
    // to land on this ticket, and no browser widget is involved.
    const widgetSessionId = randomUUID()
    const ticketId = await openFeedbackTicket(config, {
      message: supportTicketText(report.kind, report.id, report.pagePath, masked),
      distinctId: session.userId,
      widgetSessionId,
      sessionId: input.posthog.sessionId,
      tags: ticketTagsFor(report, config),
    })
    await setProductFeedbackTicket(report.id, ticketId, widgetSessionId)
    announceToSupport('product_feedback_ticket_opened', session, report, ticketId)
  } catch (error) {
    console.error(`[product-feedback] report ${report.id} stored, but no Support ticket opened:`, error)
  }
}

/**
 * Store one report from the caller, announce it to the platform owners and
 * open its Support ticket.
 *
 * Neither the announcement nor the ticket can fail the request: the stored
 * report is the record of what was sent, and the platform page lists it
 * whatever happened next.
 */
export async function submitProductFeedback(
  session: AuthorizedSession,
  input: SubmitProductFeedbackInput
): Promise<SubmittedProductFeedbackView> {
  const report = await insertProductFeedback({
    organizationId: session.organizationId,
    userId: session.userId,
    userName: session.name,
    userEmail: session.email || null,
    kind: input.kind,
    message: input.message,
    pagePath: input.pagePath ?? null,
    context: input.context,
    allowContact: input.allowContact,
  })

  await announceProductFeedback(report, await getOrganizationDisplayName(session.organizationId))

  const config = supportConfig()
  if (config) await openTicketFor(session, report, input, config)

  return { id: report.id, kind: report.kind, createdAt: report.createdAt.toISOString() }
}

// ---------------------------------------------------------------------------
// Platform triage
// ---------------------------------------------------------------------------

function personUrl(config: PosthogSupportConfig | null, userId: string): string | null {
  return config ? `${config.appHost}/project/${config.projectId}/person/${encodeURIComponent(userId)}` : null
}

// ── A ticket as the platform reads it: who has it, whose move it is ─────────

/** What naming an assignee needs: the PostHog members (when readable) and who is reading. */
interface ViewerContext {
  members: readonly PosthogMember[] | null
  viewerEmail: string | null
}

const sameEmail = (a: string | null, b: string | null): boolean =>
  Boolean(a && b && a.trim().toLowerCase() === b.trim().toLowerCase())

/**
 * The PostHog members, or `null` when they cannot be read: names are a
 * nicety, and without them the assignee shows by email.
 */
async function membersOrNull(config: PosthogSupportConfig): Promise<PosthogMember[] | null> {
  try {
    return await listPosthogMembers(config)
  } catch (error) {
    if (!(error instanceof PosthogSupportUnavailableError)) throw error
    console.warn('[product-feedback] PostHog members unreadable; assignees by email:', error.message)
    return null
  }
}

async function viewerContext(config: PosthogSupportConfig, session: GridSession | null): Promise<ViewerContext> {
  return { members: await membersOrNull(config), viewerEmail: session?.email?.trim() || null }
}

function assigneeView(ticket: SupportTicket, context: ViewerContext): ProductFeedbackAssigneeView | null {
  const { assignee } = ticket
  if (!assignee) return null
  if (assignee.type === 'role') return { type: 'role', name: assignee.name, email: null, isViewer: false }
  const member = context.members?.find((candidate) => candidate.id === assignee.id) ?? null
  const email = assignee.email ?? member?.email ?? null
  return { type: 'user', name: member?.name ?? null, email, isViewer: sameEmail(email, context.viewerEmail) }
}

/**
 * Whose move it is. A resolved ticket owes nobody; otherwise the last message
 * the reporter can see decides, and a thread that cannot be read leaves it
 * unknown rather than failing the list.
 */
async function awaitingOf(config: PosthogSupportConfig, ticket: SupportTicket): Promise<ProductFeedbackAwaiting | null> {
  if (ticket.status === 'resolved') return null
  try {
    const author = await lastVisibleMessageAuthor(config, ticket)
    if (author === 'customer') return 'team'
    if (author === 'team') return 'reporter'
    return null
  } catch (error) {
    if (!(error instanceof PosthogSupportUnavailableError)) throw error
    return null
  }
}

/** How many thread tails are read at once: a page of 50 must not open 50 sockets to PostHog. */
const THREAD_READ_CONCURRENCY = 8

async function inBatches<T, R>(items: readonly T[], size: number, map: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = []
  for (let start = 0; start < items.length; start += size) {
    out.push(...(await Promise.all(items.slice(start, start + size).map(map))))
  }
  return out
}

/** The tickets as the page shows them, keyed by ticket id. */
async function ticketViews(
  config: PosthogSupportConfig,
  tickets: readonly SupportTicket[],
  context: ViewerContext
): Promise<Map<string, ProductFeedbackTicketView>> {
  const awaiting = await inBatches(tickets, THREAD_READ_CONCURRENCY, (ticket) => awaitingOf(config, ticket))
  return new Map(
    tickets.map((ticket, index) => [
      ticket.id,
      {
        id: ticket.id,
        number: ticket.ticketNumber,
        status: ticket.status,
        url: ticket.url,
        assignee: assigneeView(ticket, context),
        lastActivityAt: ticket.lastActivityAt,
        awaiting: awaiting[index] ?? null,
      },
    ])
  )
}

/** One ticket as the page shows it, for the single-report paths. */
async function oneTicketView(
  config: PosthogSupportConfig,
  ticket: SupportTicket | null,
  session: GridSession | null
): Promise<ProductFeedbackTicketView | null> {
  if (!ticket) return null
  const views = await ticketViews(config, [ticket], await viewerContext(config, session))
  return views.get(ticket.id) ?? null
}

function toReportView(
  row: ProductFeedbackRow,
  ticket: ProductFeedbackTicketView | null,
  config: PosthogSupportConfig | null
): ProductFeedbackReportView {
  return {
    id: row.id,
    kind: row.kind,
    ticket,
    posthogPersonUrl: personUrl(config, row.userId),
    message: row.message,
    pagePath: row.pagePath,
    context: row.context ?? {},
    allowContact: row.allowContact,
    organizationId: row.organizationId,
    organizationName: row.organizationName,
    // The address is only handed over when the reporter agreed to be contacted.
    reporter: {
      userId: row.userId,
      name: row.userName,
      email: row.allowContact ? row.userEmail : null,
    },
    createdAt: new Date(row.createdAt).toISOString(),
    updatedAt: new Date(row.updatedAt).toISOString(),
  }
}

/**
 * `rows` with every organization named. The repository's join names only the
 * organizations with a local row, which exists once an organization saved a
 * setting; the rest are resolved (WorkOS, cached) rather than shown as unknown.
 */
async function withOrganizationNames(rows: ProductFeedbackRow[]): Promise<ProductFeedbackRow[]> {
  const names = await getOrganizationDisplayNames(
    rows.filter((row) => !row.organizationName).map((row) => row.organizationId)
  )
  return rows.map((row) => ({ ...row, organizationName: row.organizationName ?? names.get(row.organizationId) ?? null }))
}

/** `<createdAt ISO>|<id>` — the local log's keyset cursor, opaque to the client. */
export function encodeCursor(row: Pick<ProductFeedback, 'createdAt' | 'id'>): string {
  return `${new Date(row.createdAt).toISOString()}|${row.id}`
}

export function decodeCursor(cursor: string | undefined): { createdAt: Date; id: string } | undefined {
  if (!cursor) return undefined
  const [iso, id] = cursor.split('|')
  const createdAt = new Date(iso ?? '')
  if (!id || Number.isNaN(createdAt.getTime())) return undefined
  if (!/^[0-9a-f-]{36}$/i.test(id)) return undefined
  return { createdAt, id }
}

/** `o:<offset>` — the ticket list's cursor. Anything else starts at the top. */
const OFFSET_CURSOR = /^o:(\d{1,6})$/

/** The page size asked for, never above the repository's bound. */
const pageLimit = (query: ListProductFeedbackQuery): number =>
  Math.min(query.limit ?? PRODUCT_FEEDBACK_LIST_LIMIT, PRODUCT_FEEDBACK_LIST_LIMIT)

function decodeOffset(cursor: string | undefined): number {
  const match = cursor ? OFFSET_CURSOR.exec(cursor) : null
  return match ? Number(match[1]) : 0
}

/** The local log alone: newest first, no triage state. */
async function listLocal(
  query: ListProductFeedbackQuery,
  config: PosthogSupportConfig | null
): Promise<ProductFeedbackListResponse> {
  const rows = await listProductFeedback({
    kind: query.kind,
    before: decodeCursor(query.cursor),
    limit: pageLimit(query),
  })
  const last = rows.at(-1)
  return {
    source: 'local',
    reports: (await withOrganizationNames(rows)).map((row) => toReportView(row, null, config)),
    counts: null,
    unticketed: [],
    nextCursor: rows.length === pageLimit(query) && last ? encodeCursor(last) : null,
    viewerNotInPosthog: false,
  }
}

const zeroCounts = (): Record<SupportTicketStatus, number> =>
  Object.fromEntries(SUPPORT_TICKET_STATUSES.map((status) => [status, 0])) as Record<SupportTicketStatus, number>

/**
 * The PostHog side of the assignee filter. `mine` needs the reader's PostHog
 * id, found by their email in the members list; a members list that cannot be
 * read makes the whole list unreadable (the local log answers), and a reader
 * nobody in PostHog has is `'nobody'`: nothing is theirs.
 */
function assigneeFilterOf(
  query: ListProductFeedbackQuery,
  context: ViewerContext
): SupportTicketAssigneeFilter | 'nobody' | undefined {
  if (query.assignee === 'unassigned') return 'unassigned'
  if (query.assignee !== 'mine') return undefined
  if (!context.members) throw new PosthogSupportUnavailableError('PostHog Support: members unreadable for `mine`')
  const viewer = context.viewerEmail ? memberByEmail(context.members, context.viewerEmail) : null
  return viewer ? { userId: viewer.id } : 'nobody'
}

/** One page of PostHog tickets joined to their reports, and the reports that have none. */
async function listFromPosthog(
  query: ListProductFeedbackQuery,
  config: PosthogSupportConfig,
  session: GridSession | null
): Promise<ProductFeedbackListResponse> {
  const offset = decodeOffset(query.cursor)
  const context = await viewerContext(config, session)
  const assignee = assigneeFilterOf(query, context)
  if (assignee === 'nobody') {
    return { source: 'posthog', reports: [], counts: zeroCounts(), unticketed: [], nextCursor: null, viewerNotInPosthog: true }
  }
  const status = query.status === 'active' ? ACTIVE_SUPPORT_TICKET_STATUSES : query.status
  const [page, counts] = await Promise.all([
    listFeedbackTickets(config, { status, kind: query.kind, assignee, limit: pageLimit(query), offset }),
    countFeedbackTicketsByStatus(config, fetch, { assignee }),
  ])
  const since = new Date(Date.now() - UNTICKETED_WINDOW_DAYS * 24 * 60 * 60 * 1000)
  const [byTicket, unticketedRows, views] = await Promise.all([
    getProductFeedbackByTicketIds(page.tickets.map((ticket) => ticket.id)),
    // On the first page only: there are few, and every page would repeat them.
    // A report without a ticket is nobody's, so an assignee filter leaves it out.
    offset === 0 && !assignee
      ? listProductFeedback({ kind: query.kind, unticketed: true, since, limit: PRODUCT_FEEDBACK_LIST_LIMIT })
      : Promise.resolve([]),
    ticketViews(config, page.tickets, context),
  ])
  // A tagged ticket without a local row lost its report (deleted with its
  // organization); there is nothing of ours to show for it.
  const joined = page.tickets.flatMap((ticket) => {
    const row = byTicket.get(ticket.id)
    return row ? [{ row, ticket }] : []
  })
  const named = await withOrganizationNames([...joined.map((entry) => entry.row), ...unticketedRows])
  const nextOffset = offset + page.tickets.length
  return {
    source: 'posthog',
    reports: joined.map((entry, index) =>
      toReportView(named[index] ?? entry.row, views.get(entry.ticket.id) ?? null, config)
    ),
    counts,
    unticketed: named.slice(joined.length).map((row) => toReportView(row, null, config)),
    nextCursor:
      page.tickets.length === pageLimit(query) && nextOffset < page.count ? `o:${nextOffset}` : null,
    viewerNotInPosthog: false,
  }
}

/**
 * One page of the triage list: PostHog's tickets when Support is configured
 * and answers, the local log otherwise. A PostHog failure is not an error for
 * the platform owner, only a read-only page.
 */
export async function listProductFeedbackForPlatform(
  session: GridSession | null,
  query: ListProductFeedbackQuery
): Promise<ProductFeedbackListResponse> {
  await requirePlatformPermission(session, PLATFORM_PERMISSIONS.settingsView)
  const config = supportConfig()
  return withPlatformAccess('product feedback: triage list', async () => {
    if (!config) return listLocal(query, null)
    try {
      return await listFromPosthog(query, config, session)
    } catch (error) {
      if (!(error instanceof PosthogSupportUnavailableError)) throw error
      console.warn('[product-feedback] PostHog Support unreadable; listing the local log:', error.message)
      // An offset cursor means nothing to the local log: start at the top.
      return listLocal({ ...query, cursor: undefined }, config)
    }
  })
}

/** The live ticket for a row, or `null` when it has none or PostHog cannot say. */
async function ticketFor(row: ProductFeedbackRow, config: PosthogSupportConfig | null): Promise<SupportTicket | null> {
  if (!config || !row.posthogTicketId) return null
  try {
    return await getSupportTicket(config, row.posthogTicketId)
  } catch (error) {
    if (!(error instanceof PosthogSupportUnavailableError)) throw error
    return null
  }
}

/** One report, for the deep link an inbox row lands on. */
export async function getProductFeedbackForPlatform(
  session: GridSession | null,
  id: string
): Promise<ProductFeedbackReportView> {
  await requirePlatformPermission(session, PLATFORM_PERMISSIONS.settingsView)
  const row = await withPlatformAccess('product feedback: one report', () => getProductFeedback(id))
  if (!row) throw new NotFoundError('Unknown feedback report.')
  const config = supportConfig()
  const [[named], ticket] = await Promise.all([withOrganizationNames([row]), ticketFor(row, config)])
  return toReportView(named ?? row, config ? await oneTicketView(config, ticket, session) : null, config)
}

/**
 * Move a report's Support ticket to `status`. PostHog records who did it; a
 * report without a ticket has nothing to move.
 */
export async function triageProductFeedback(
  session: GridSession | null,
  id: string,
  status: SupportTicketStatus
): Promise<ProductFeedbackReportView> {
  await requirePlatformPermission(session, PLATFORM_PERMISSIONS.settingsManage)
  const row = await withPlatformAccess('product feedback: triage', () => getProductFeedback(id))
  if (!row) throw new NotFoundError('Unknown feedback report.')
  const config = supportConfig()
  if (!config || !row.posthogTicketId) {
    throw new ConflictError('This report has no PostHog Support ticket to move.')
  }
  let ticket: SupportTicket
  try {
    ticket = await updateSupportTicketStatus(config, row.posthogTicketId, status)
  } catch (error) {
    if (error instanceof PosthogSupportUnavailableError) throw new UpstreamError('PostHog Support did not take the change.')
    throw error
  }
  const [named] = await withOrganizationNames([row])
  return toReportView(named ?? row, await oneTicketView(config, ticket, session), config)
}

// ---------------------------------------------------------------------------
// The reporter's own threads
// ---------------------------------------------------------------------------
//
// A member reads what the team answered on their reports, and answers back,
// inside Piloti. PostHog Support stays the record: the thread is read from the
// ticket each time, and a reply goes onto the ticket. Nothing is copied here
// except when the reporter last looked (`reporter_seen_at`). Every function
// narrows to the caller's own reports; a colleague's report is a 404.

/**
 * How many of a person's tickets one PostHog call reads, most recently updated
 * first. Far above what anyone sends; a report whose ticket falls outside it
 * shows without a status, never wrongly.
 */
const OWN_TICKETS_LIMIT = 100

/** How long the list's excerpt of a report is. */
const EXCERPT_LENGTH = 140

function excerptOf(message: string): string {
  const flat = message.replace(/\s+/g, ' ').trim()
  return flat.length > EXCERPT_LENGTH ? `${flat.slice(0, EXCERPT_LENGTH - 1)}…` : flat
}

/** Whether the ticket moved since the reporter last looked. */
function hasUpdateSince(row: ProductFeedback, ticket: SupportTicket | null): boolean {
  if (!ticket || !row.reporterSeenAt) return false
  return new Date(ticket.updatedAt).getTime() > new Date(row.reporterSeenAt).getTime()
}

function toOwnSummary(
  row: ProductFeedback,
  ticket: SupportTicket | null,
  config: PosthogSupportConfig | null
): OwnProductFeedbackSummary {
  return {
    id: row.id,
    kind: row.kind,
    excerpt: excerptOf(row.message),
    createdAt: new Date(row.createdAt).toISOString(),
    status: ticket?.status ?? null,
    hasUpdate: hasUpdateSince(row, ticket),
    canReply: Boolean(config && row.posthogTicketId && row.posthogWidgetSessionId),
  }
}

/** The caller's own report, or 404: a report that is not theirs does not exist for them. */
async function ownReport(session: AuthorizedSession, id: string): Promise<ProductFeedback> {
  const row = await getOwnProductFeedback(session.organizationId, session.userId, id)
  if (!row) throw new NotFoundError('Unknown feedback report.')
  return row
}

/**
 * The caller's own reports, newest first, with each ticket's status and
 * whether the team did something since they last looked. One PostHog call for
 * all of them; while PostHog cannot be read the list is still there, without
 * statuses (`live: false`).
 */
export async function listOwnProductFeedbackThreads(
  session: AuthorizedSession,
  query: ListOwnProductFeedbackQuery = { limit: OWN_PRODUCT_FEEDBACK_LIMIT }
): Promise<OwnProductFeedbackListResponse> {
  const limit = Math.min(query.limit, OWN_PRODUCT_FEEDBACK_LIMIT)
  const rows = await listOwnProductFeedback(session.organizationId, session.userId, {
    limit,
    before: decodeCursor(query.cursor),
  })
  const config = supportConfig()
  let tickets = new Map<string, SupportTicket>()
  let live = config !== null
  if (config && rows.some((row) => row.posthogTicketId)) {
    try {
      const own = await listFeedbackTicketsOf(config, session.userId, OWN_TICKETS_LIMIT)
      tickets = new Map(own.map((ticket) => [ticket.id, ticket]))
    } catch (error) {
      if (!(error instanceof PosthogSupportUnavailableError)) throw error
      console.warn('[product-feedback] PostHog Support unreadable; own threads without status:', error.message)
      live = false
    }
  }
  const reports = rows.map((row) =>
    toOwnSummary(row, row.posthogTicketId ? (tickets.get(row.posthogTicketId) ?? null) : null, config)
  )
  const last = rows.at(-1)
  return {
    reports,
    updatedCount: reports.filter((report) => report.hasUpdate).length,
    live,
    nextCursor: rows.length === limit && last ? encodeCursor(last) : null,
  }
}

/**
 * The thread as the reporter sees it: their report as they typed it, then the
 * ticket's later messages. The ticket's own first message is the masked copy
 * with the report header (`supportTicketText`), so it is replaced by the words
 * the reporter wrote. Their later replies come back as PostHog holds them,
 * masked against the office's policy like everything that leaves for PostHog.
 */
function threadMessages(row: ProductFeedback, ticketMessages: SupportMessage[]): OwnProductFeedbackMessage[] {
  const header = `[${row.kind}] #${row.id}`
  const first: OwnProductFeedbackMessage = {
    id: row.id,
    author: 'me',
    authorName: null,
    content: row.message,
    createdAt: new Date(row.createdAt).toISOString(),
  }
  const rest = ticketMessages
    .filter((message) => !(message.author === 'customer' && message.content.startsWith(header)))
    .map((message) => ({
      id: message.id,
      author: message.author === 'customer' ? ('me' as const) : ('team' as const),
      authorName: message.authorName,
      content: message.content,
      createdAt: message.createdAt,
    }))
  return [first, ...rest]
}

/** The ticket and its visible messages, or `null` when there is none or PostHog cannot say. */
async function liveThread(
  row: ProductFeedback,
  config: PosthogSupportConfig | null
): Promise<{ ticket: SupportTicket; messages: SupportMessage[] } | null> {
  if (!config || !row.posthogTicketId) return null
  try {
    const [ticket, messages] = await Promise.all([
      getSupportTicket(config, row.posthogTicketId),
      listCustomerVisibleMessages(config, row.posthogTicketId),
    ])
    return ticket ? { ticket, messages } : null
  } catch (error) {
    if (!(error instanceof PosthogSupportUnavailableError)) throw error
    console.warn(`[product-feedback] thread of report ${row.id} unreadable:`, error.message)
    return null
  }
}

/** One of the caller's threads. Opening it counts as having seen it. */
export async function getOwnProductFeedbackThread(
  session: AuthorizedSession,
  id: string
): Promise<OwnProductFeedbackThread> {
  const row = await ownReport(session, id)
  const config = supportConfig()
  const live = await liveThread(row, config)
  const seenAt = new Date()
  if (live) await markOwnProductFeedbackSeen(session.organizationId, session.userId, row.id, seenAt)
  const seen = live ? { ...row, reporterSeenAt: seenAt } : row
  return {
    report: toOwnSummary(seen, live?.ticket ?? null, config),
    messages: threadMessages(row, live?.messages ?? []),
    live: live !== null,
  }
}

/**
 * The reporter answers on their thread. The words go out masked against the
 * office's „Sensible Daten" policy (ADR-0086), like the report did: when the
 * policy cannot be read, nothing is sent. Resolves to the updated thread.
 */
export async function replyToOwnProductFeedback(
  session: AuthorizedSession,
  id: string,
  message: string
): Promise<OwnProductFeedbackThread> {
  const row = await ownReport(session, id)
  const config = supportConfig()
  if (!config || !row.posthogTicketId || !row.posthogWidgetSessionId) {
    throw new ConflictError('This report cannot be answered here.')
  }
  let masked: string
  try {
    masked = (await maskChatText(session.organizationId, message)).text
  } catch (error) {
    console.error(`[product-feedback] reply on report ${row.id} not sent: the policy could not mask it`, error)
    throw new UpstreamError('Your reply could not be sent.')
  }
  try {
    await replyAsCustomer(config, {
      ticketId: row.posthogTicketId,
      widgetSessionId: row.posthogWidgetSessionId,
      distinctId: session.userId,
      message: masked,
    })
  } catch (error) {
    if (error instanceof PosthogSupportUnavailableError) throw new UpstreamError('Your reply could not be sent.')
    throw error
  }
  announceToSupport('product_feedback_reply_sent', session, row, row.posthogTicketId)
  return getOwnProductFeedbackThread(session, id)
}

// ---------------------------------------------------------------------------
// Taking a ticket
// ---------------------------------------------------------------------------

/**
 * A platform owner takes a report's ticket: it is assigned to them in PostHog
 * Support. The Slack alert's „Übernehmen" button lands here with the ticket id,
 * so the person is whoever is signed in to Piloti, and their PostHog account is
 * the one with the same email. No Slack identity is involved.
 */
export async function claimProductFeedbackTicket(
  session: GridSession | null,
  ticketId: string
): Promise<ProductFeedbackReportView> {
  await requirePlatformPermission(session, PLATFORM_PERMISSIONS.settingsManage)
  const config = supportConfig()
  if (!config) throw new ConflictError('PostHog Support is not configured here.')
  const row = await withPlatformAccess('product feedback: claim', async () =>
    (await getProductFeedbackByTicketIds([ticketId])).get(ticketId)
  )
  if (!row) throw new NotFoundError('Unknown feedback ticket.')
  const email = session?.email?.trim()
  if (!email) throw new ConflictError('Your account has no email to find you in PostHog by.')
  let ticket: SupportTicket
  try {
    const posthogUserId = await findPosthogUserIdByEmail(config, email)
    if (posthogUserId === null) {
      throw new ConflictError('Nobody in PostHog has your email, so the ticket cannot be assigned to you.')
    }
    ticket = await assignSupportTicket(config, ticketId, posthogUserId)
  } catch (error) {
    if (error instanceof PosthogSupportUnavailableError) throw new UpstreamError('PostHog Support did not take the change.')
    throw error
  }
  const [named] = await withOrganizationNames([row])
  return toReportView(named ?? row, await oneTicketView(config, ticket, session), config)
}
