/**
 * The BFF's PostHog Support client.
 *
 * Two doors into PostHog, and no widget UI behind either. Whatever the
 * REPORTER says (the ticket's first message, every later reply) goes through
 * the public conversations endpoint on the ingestion host, because PostHog's
 * REST API only lets the team author messages: a ticket is opened, and later
 * answered, under the reporter's distinct id in a conversations session the
 * server made up and stored with the report. Everything else (list, read the
 * thread, status, tags) goes through the private REST API on the app host with
 * the personal API key.
 *
 * Every failure surfaces as `PosthogSupportUnavailableError`; callers fall
 * back to the local feedback log. The API key is never logged or put in an
 * error message.
 */

import 'server-only'
import { z } from 'zod'
import {
  FEEDBACK_TICKET_TAG,
  kindTicketTag,
  PosthogSupportUnavailableError,
  SUPPORT_TICKET_STATUSES,
  type CustomerReplyInput,
  type OpenFeedbackTicketInput,
  type PosthogMember,
  type PosthogSupportConfig,
  type SupportMessage,
  type SupportMessageAuthor,
  type SupportTicket,
  type SupportTicketAssignee,
  type SupportTicketPage,
  type SupportTicketStatus,
} from './types'

const REQUEST_TIMEOUT_MS = 8000
const WIDGET_TOKEN_TTL_MS = 10 * 60 * 1000

// ── Response shapes, read defensively ────────────────────────────────────────

/** PostHog has served tags both as names and as `{ name }` objects; accept either. */
const tagSchema = z.union([
  z.string(),
  z
    .object({ name: z.string() })
    .passthrough()
    .transform((tag) => tag.name),
])

/**
 * The assignee as PostHog serves it on a ticket:
 * `{ id, type: 'user', user: { email }, role: null }` for a person, or a role.
 * Anything else reads as unassigned rather than failing the row.
 */
const assigneeSchema = z
  .union([
    z
      .object({
        type: z.literal('user'),
        id: z.number().int(),
        user: z.object({ email: z.string().nullish() }).passthrough().nullish(),
      })
      .passthrough()
      .transform((raw): SupportTicketAssignee => ({ type: 'user', id: raw.id, email: raw.user?.email ?? null })),
    z
      .object({
        type: z.literal('role'),
        id: z.union([z.string(), z.number()]),
        role: z.object({ name: z.string().nullish() }).passthrough().nullish(),
      })
      .passthrough()
      .transform((raw): SupportTicketAssignee => ({ type: 'role', id: String(raw.id), name: raw.role?.name ?? null })),
  ])
  .nullish()
  .catch(null)

const ticketSchema = z
  .object({
    id: z.string().min(1),
    ticket_number: z.number().int().nullish().catch(null),
    status: z.enum(SUPPORT_TICKET_STATUSES),
    tags: z.array(tagSchema).nullish().catch(null),
    assignee: assigneeSchema,
    last_message_at: z.string().nullish().catch(null),
    message_count: z.number().int().nonnegative().nullish().catch(null),
    unread_team_count: z.number().int().nonnegative().nullish().catch(null),
    created_at: z.string(),
    updated_at: z.string(),
  })
  .passthrough()

const pageSchema = z
  .object({ count: z.number().int().nonnegative(), results: z.array(z.unknown()) })
  .passthrough()

/** The public remote config posthog-js loads; its `conversations.token` is the widget token. */
const remoteConfigSchema = z
  .object({ conversations: z.object({ token: z.string().min(1) }).passthrough() })
  .passthrough()

const widgetMessageSchema = z.object({ ticket_id: z.string().min(1) }).passthrough()

/**
 * One message of a ticket's thread from the private API. `message_type`
 * separates what the reporter may see (`customer_message`, `sent_reply`) from
 * what they never may (`internal_note`, `ai_draft`, both `is_private`).
 */
const threadMessageSchema = z
  .object({
    id: z.string().min(1),
    message_type: z.string(),
    content: z.string().nullish().catch(null),
    author_name: z.string().nullish().catch(null),
    is_private: z.boolean().catch(true),
    created_at: z.string(),
  })
  .passthrough()

// ── Transport ────────────────────────────────────────────────────────────────

const ticketsUrl = (config: PosthogSupportConfig): string =>
  `${config.appHost}/api/projects/${config.projectId}/conversations/tickets/`

const ticketUrl = (config: PosthogSupportConfig, id: string): string =>
  `${ticketsUrl(config)}${encodeURIComponent(id)}/`

const privateHeaders = (config: PosthogSupportConfig): Record<string, string> => ({
  Authorization: `Bearer ${config.personalApiKey}`,
  Accept: 'application/json',
})

/** One request; a network error or timeout becomes `PosthogSupportUnavailableError`. */
async function send(
  fetchImpl: typeof fetch,
  what: string,
  url: string,
  init: RequestInit
): Promise<Response> {
  try {
    return await fetchImpl(url, { ...init, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) })
  } catch (error) {
    const reason = error instanceof Error ? error.name : 'unknown error'
    throw new PosthogSupportUnavailableError(`PostHog Support ${what}: request failed (${reason})`)
  }
}

/** The JSON body of a 2xx response, or `PosthogSupportUnavailableError`. */
async function jsonOf(response: Response, what: string): Promise<unknown> {
  if (!response.ok) {
    throw new PosthogSupportUnavailableError(
      `PostHog Support ${what}: HTTP ${response.status}`,
      response.status
    )
  }
  try {
    return await response.json()
  } catch {
    throw new PosthogSupportUnavailableError(
      `PostHog Support ${what}: unreadable body`,
      response.status
    )
  }
}

function parseOrThrow<T>(
  schema: z.ZodType<T, z.ZodTypeDef, unknown>,
  body: unknown,
  what: string
): T {
  const parsed = schema.safeParse(body)
  if (!parsed.success)
    throw new PosthogSupportUnavailableError(`PostHog Support ${what}: unexpected response shape`)
  return parsed.data
}

/** A ticket the app can read, or `null` for a row it cannot. */
function toTicket(config: PosthogSupportConfig, raw: unknown): SupportTicket | null {
  const parsed = ticketSchema.safeParse(raw)
  if (!parsed.success) return null
  const row = parsed.data
  return {
    id: row.id,
    ticketNumber: row.ticket_number ?? null,
    status: row.status,
    tags: row.tags ?? [],
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    assignee: row.assignee ?? null,
    lastActivityAt: row.last_message_at ?? row.updated_at,
    messageCount: row.message_count ?? null,
    unreadTeamCount: row.unread_team_count ?? 0,
    url: `${config.appHost}/project/${config.projectId}/support/tickets/${encodeURIComponent(row.id)}`,
  }
}

function ticketOrThrow(config: PosthogSupportConfig, body: unknown, what: string): SupportTicket {
  const ticket = toTicket(config, body)
  if (!ticket)
    throw new PosthogSupportUnavailableError(`PostHog Support ${what}: unexpected response shape`)
  return ticket
}

async function patchTicket(
  config: PosthogSupportConfig,
  id: string,
  patch: { status: SupportTicketStatus } | { tags: string[] } | { assignee: { type: 'user'; id: number } },
  what: string,
  fetchImpl: typeof fetch
): Promise<SupportTicket> {
  const response = await send(fetchImpl, what, ticketUrl(config, id), {
    method: 'PATCH',
    headers: { ...privateHeaders(config), 'Content-Type': 'application/json' },
    body: JSON.stringify(patch),
  })
  return ticketOrThrow(config, await jsonOf(response, what), what)
}

// ── The widget token ─────────────────────────────────────────────────────────

/** Per project: the public widget token changes only when somebody rotates it. */
const widgetTokens = new Map<string, { token: string; expiresAt: number }>()

/** Test hook: forget every cached widget token. */
export function resetWidgetTokenCacheForTests(): void {
  widgetTokens.clear()
}

/**
 * The project's Support widget token, read from the public remote config that
 * posthog-js itself loads (`/array/<project token>/config`). It is public by
 * design, so this needs no key: asking the private API for it needed
 * `project:read`, and a key without that scope opened no ticket at all.
 */
async function widgetToken(config: PosthogSupportConfig, fetchImpl: typeof fetch): Promise<string> {
  const cached = widgetTokens.get(config.projectToken)
  if (cached && cached.expiresAt > Date.now()) return cached.token
  const what = 'widget token'
  const url = `${config.ingestHost}/array/${encodeURIComponent(config.projectToken)}/config`
  const response = await send(fetchImpl, what, url, { headers: { Accept: 'application/json' } })
  const remote = parseOrThrow(remoteConfigSchema, await jsonOf(response, what), what)
  const token = remote.conversations.token
  widgetTokens.set(config.projectToken, { token, expiresAt: Date.now() + WIDGET_TOKEN_TTL_MS })
  return token
}

// ── The contract ─────────────────────────────────────────────────────────────

/**
 * Post one message as the reporter, through the public conversations endpoint.
 * `ticketId: null` opens a new ticket; otherwise the message lands on that
 * ticket, which PostHog accepts only from the session that opened it.
 * Resolves to the ticket's id.
 */
async function postCustomerMessage(
  config: PosthogSupportConfig,
  input: {
    message: string
    distinctId: string
    widgetSessionId: string
    ticketId: string | null
    sessionId: string | null
  },
  what: string,
  fetchImpl: typeof fetch
): Promise<string> {
  const token = await widgetToken(config, fetchImpl)
  const response = await send(
    fetchImpl,
    what,
    `${config.ingestHost}/api/conversations/v1/widget/message`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Conversations-Token': token,
        // The project's Allowed domains apply to this call too; the browser
        // would send the app's origin, so the server sends the same.
        ...(config.appOrigin ? { Origin: config.appOrigin } : {}),
      },
      body: JSON.stringify({
        message: input.message,
        traits: { name: null, email: null },
        ticket_id: input.ticketId,
        widget_session_id: input.widgetSessionId,
        distinct_id: input.distinctId,
        ...(input.sessionId !== null ? { session_id: input.sessionId } : {}),
      }),
    }
  )
  // A refused token was probably rotated: fetch it afresh next time.
  if (response.status === 401 || response.status === 403) widgetTokens.delete(config.projectToken)
  return parseOrThrow(widgetMessageSchema, await jsonOf(response, what), what).ticket_id
}

/**
 * Open a ticket for one report and tag it. Resolves to the new ticket's id.
 *
 * The ticket exists once the widget endpoint answers; a failed tag write after
 * that only leaves it untagged, so it is warned about and the id still returned.
 */
export async function openFeedbackTicket(
  config: PosthogSupportConfig,
  input: OpenFeedbackTicketInput,
  fetchImpl: typeof fetch = fetch
): Promise<string> {
  const ticketId = await postCustomerMessage(
    config,
    {
      message: input.message,
      distinctId: input.distinctId,
      widgetSessionId: input.widgetSessionId,
      ticketId: null,
      sessionId: input.sessionId,
    },
    'open ticket',
    fetchImpl
  )

  try {
    await patchTicket(config, ticketId, { tags: input.tags }, 'tag ticket', fetchImpl)
  } catch (error) {
    const reason = error instanceof Error ? error.message : 'unknown error'
    console.warn(`[posthog-support] ticket ${ticketId} opened but not tagged: ${reason}`)
  }
  return ticketId
}

/** The reporter answers on their own ticket. The message is masked already. */
export async function replyAsCustomer(
  config: PosthogSupportConfig,
  input: CustomerReplyInput,
  fetchImpl: typeof fetch = fetch
): Promise<void> {
  const ticketId = await postCustomerMessage(
    config,
    { ...input, sessionId: null },
    'customer reply',
    fetchImpl
  )
  // PostHog opening a second ticket instead would split the conversation.
  if (ticketId !== input.ticketId) {
    throw new PosthogSupportUnavailableError('PostHog Support customer reply: landed on another ticket')
  }
}

/** Longest thread read in one call; PostHog pages at most 200. */
const THREAD_PAGE_LIMIT = 200

/**
 * A ticket's thread as its reporter may see it, oldest first: their own
 * messages and the replies sent to them. Internal notes and AI drafts are
 * dropped here, so no caller can hand them on by mistake.
 */
export async function listCustomerVisibleMessages(
  config: PosthogSupportConfig,
  ticketId: string,
  fetchImpl: typeof fetch = fetch
): Promise<SupportMessage[]> {
  const what = 'list messages'
  const response = await send(
    fetchImpl,
    what,
    `${ticketUrl(config, ticketId)}messages/?limit=${THREAD_PAGE_LIMIT}`,
    { headers: privateHeaders(config) }
  )
  const page = parseOrThrow(pageSchema, await jsonOf(response, what), what)
  return page.results.flatMap((raw): SupportMessage[] => {
    const parsed = threadMessageSchema.safeParse(raw)
    if (!parsed.success || parsed.data.is_private) return []
    const row = parsed.data
    if (row.message_type !== 'customer_message' && row.message_type !== 'sent_reply') return []
    const author = row.message_type === 'customer_message' ? 'customer' : 'team'
    return [
      {
        id: row.id,
        author,
        authorName: author === 'team' ? (row.author_name ?? null) : null,
        content: row.content ?? '',
        createdAt: row.created_at,
      },
    ]
  })
}

/** The most people one `distinct_ids` filter names; PostHog refuses more. */
export const DISTINCT_IDS_MAX = 100

/**
 * The feedback tickets (tag `FEEDBACK_TICKET_TAG`) of one person, or of a few
 * (an office's page of reports), most recently updated first: one call for
 * every thread they have. `date_from=all` switches off the list's updated-at
 * window explicitly ("Pass `all` to disable the filter", PostHog's own
 * parameter doc), so an old open case keeps its status whatever the server's
 * default window is.
 */
export async function listFeedbackTicketsOf(
  config: PosthogSupportConfig,
  distinctIds: string | readonly string[],
  limit: number,
  fetchImpl: typeof fetch = fetch
): Promise<SupportTicket[]> {
  const ids = [...new Set(typeof distinctIds === 'string' ? [distinctIds] : distinctIds)].slice(0, DISTINCT_IDS_MAX)
  if (ids.length === 0) return []
  const params = new URLSearchParams({
    distinct_ids: ids.join(','),
    date_from: 'all',
    tags_all: JSON.stringify([FEEDBACK_TICKET_TAG]),
    limit: String(limit),
    order_by: '-updated_at',
  })
  const what = 'list tickets of a person'
  const response = await send(fetchImpl, what, `${ticketsUrl(config)}?${params.toString()}`, {
    headers: privateHeaders(config),
  })
  const page = parseOrThrow(pageSchema, await jsonOf(response, what), what)
  return page.results.map((raw) => toTicket(config, raw)).filter((t): t is SupportTicket => t !== null)
}

/**
 * Whose tickets to list: nobody's (`unassigned`) or one PostHog user's (their
 * integer id). Absent lists everyone's.
 */
export type SupportTicketAssigneeFilter = 'unassigned' | { userId: number }

export interface FeedbackTicketQuery {
  /** One status, or several (PostHog matches any). Absent or empty lists every status. */
  status?: SupportTicketStatus | readonly SupportTicketStatus[]
  kind?: string
  assignee?: SupportTicketAssigneeFilter
  limit: number
  offset: number
}

function assigneeParam(filter: SupportTicketAssigneeFilter): string {
  return filter === 'unassigned' ? 'unassigned' : `user:${filter.userId}`
}

/**
 * One page of feedback tickets (tag `FEEDBACK_TICKET_TAG`), newest first.
 * `kind` narrows to one report kind (`kind:<kind>` tag), `assignee` to one
 * person's tickets or to the unassigned ones.
 */
export async function listFeedbackTickets(
  config: PosthogSupportConfig,
  query: FeedbackTicketQuery,
  fetchImpl: typeof fetch = fetch
): Promise<SupportTicketPage> {
  const tagsAll = [FEEDBACK_TICKET_TAG, ...(query.kind ? [kindTicketTag(query.kind)] : [])]
  const params = new URLSearchParams({
    tags_all: JSON.stringify(tagsAll),
    limit: String(query.limit),
    offset: String(query.offset),
    order_by: '-created_at',
  })
  const statuses = typeof query.status === 'string' ? [query.status] : (query.status ?? [])
  if (statuses.length > 0) params.set('status', statuses.join(','))
  if (query.assignee) params.set('assignee', assigneeParam(query.assignee))
  const what = 'list tickets'
  const response = await send(fetchImpl, what, `${ticketsUrl(config)}?${params.toString()}`, {
    headers: privateHeaders(config),
  })
  const page = parseOrThrow(pageSchema, await jsonOf(response, what), what)
  const tickets = page.results
    .map((raw) => toTicket(config, raw))
    .filter((t): t is SupportTicket => t !== null)
  return { tickets, count: page.count }
}

/**
 * Count of feedback tickets per status: one `limit=1` list call per status, in
 * parallel. `assignee` counts only that person's tickets, or the unassigned ones.
 */
export async function countFeedbackTicketsByStatus(
  config: PosthogSupportConfig,
  fetchImpl: typeof fetch = fetch,
  filter: { assignee?: SupportTicketAssigneeFilter } = {}
): Promise<Record<SupportTicketStatus, number>> {
  const counts = await Promise.all(
    SUPPORT_TICKET_STATUSES.map(async (status) => {
      const page = await listFeedbackTickets(
        config,
        { status, assignee: filter.assignee, limit: 1, offset: 0 },
        fetchImpl
      )
      return [status, page.count] as const
    })
  )
  return Object.fromEntries(counts) as Record<SupportTicketStatus, number>
}

/** One ticket, or `null` when PostHog does not know it. */
export async function getSupportTicket(
  config: PosthogSupportConfig,
  id: string,
  fetchImpl: typeof fetch = fetch
): Promise<SupportTicket | null> {
  const what = 'get ticket'
  const response = await send(fetchImpl, what, ticketUrl(config, id), {
    headers: privateHeaders(config),
  })
  if (response.status === 404) return null
  return ticketOrThrow(config, await jsonOf(response, what), what)
}

/** Move a ticket to a status; resolves to the updated ticket. */
export async function updateSupportTicketStatus(
  config: PosthogSupportConfig,
  id: string,
  status: SupportTicketStatus,
  fetchImpl: typeof fetch = fetch
): Promise<SupportTicket> {
  return patchTicket(config, id, { status }, 'update status', fetchImpl)
}

/** One member of the PostHog organization, as the members list serves it. */
const memberSchema = z
  .object({
    user: z
      .object({
        id: z.number().int(),
        email: z.string(),
        first_name: z.string().nullish().catch(null),
        last_name: z.string().nullish().catch(null),
      })
      .passthrough(),
  })
  .passthrough()

/** The members list is read at most this often; a claim that misses reads it afresh. */
const MEMBERS_TTL_MS = 5 * 60 * 1000

/** Largest members page read; the team is a handful of people. */
const MEMBERS_PAGE_LIMIT = 200

/**
 * Per PostHog host and project. The organization behind `@current` is the
 * personal key's own, the same whichever Piloti organization a report came
 * from (platform scope), so this holds no tenant data.
 */
const membersCache = new Map<string, { members: PosthogMember[]; expiresAt: number }>()

/** Test hook: forget the cached members list. */
export function resetMembersCacheForTests(): void {
  membersCache.clear()
}

const normalEmail = (email: string): string => email.trim().toLowerCase()

/**
 * The members of the PostHog organization the personal API key belongs to,
 * with their names: how an assignee's id or email becomes a person. Cached for
 * a few minutes; `fresh` skips the cache. Needs `organization_member:read`.
 */
export async function listPosthogMembers(
  config: PosthogSupportConfig,
  fetchImpl: typeof fetch = fetch,
  options: { fresh?: boolean } = {}
): Promise<PosthogMember[]> {
  const key = `${config.appHost}|${config.projectId}`
  const cached = membersCache.get(key)
  if (!options.fresh && cached && cached.expiresAt > Date.now()) return cached.members
  const what = 'list members'
  const response = await send(
    fetchImpl,
    what,
    `${config.appHost}/api/organizations/@current/members/?limit=${MEMBERS_PAGE_LIMIT}`,
    { headers: privateHeaders(config) }
  )
  const page = parseOrThrow(pageSchema, await jsonOf(response, what), what)
  const members = page.results.flatMap((raw): PosthogMember[] => {
    const parsed = memberSchema.safeParse(raw)
    if (!parsed.success) return []
    const { id, email, first_name, last_name } = parsed.data.user
    const name = [first_name, last_name].filter(Boolean).join(' ').trim()
    return [{ id, email, name: name || null }]
  })
  membersCache.set(key, { members, expiresAt: Date.now() + MEMBERS_TTL_MS })
  return members
}

/** The member with this email, case-insensitively, or `null`. */
export function memberByEmail(members: readonly PosthogMember[], email: string): PosthogMember | null {
  const wanted = normalEmail(email)
  return members.find((member) => normalEmail(member.email) === wanted) ?? null
}

/**
 * The PostHog user id (the integer the ticket's assignee takes) of the member
 * with this email, or `null` when nobody in the PostHog organization has it.
 * A miss in the cached list reads the list afresh: the person may have joined
 * PostHog a minute ago.
 */
export async function findPosthogUserIdByEmail(
  config: PosthogSupportConfig,
  email: string,
  fetchImpl: typeof fetch = fetch
): Promise<number | null> {
  const cached = memberByEmail(await listPosthogMembers(config, fetchImpl), email)
  if (cached) return cached.id
  return memberByEmail(await listPosthogMembers(config, fetchImpl, { fresh: true }), email)?.id ?? null
}

// ── Who wrote last ───────────────────────────────────────────────────────────

/** How many messages from the end of a thread are read to find the last visible one. */
const THREAD_TAIL = 5

/** Remembered per ticket and `updatedAt`: a new message moves `updatedAt`, so a hit is never stale. */
const LAST_AUTHOR_CACHE_MAX = 1000
const lastAuthors = new Map<string, SupportMessageAuthor | null>()

/** Test hook: forget every remembered last author. */
export function resetLastAuthorCacheForTests(): void {
  lastAuthors.clear()
}

function rememberLastAuthor(key: string, author: SupportMessageAuthor | null): void {
  if (lastAuthors.size >= LAST_AUTHOR_CACHE_MAX) {
    const oldest = lastAuthors.keys().next()
    if (!oldest.done) lastAuthors.delete(oldest.value)
  }
  lastAuthors.set(key, author)
}

/** The author of the last message the reporter can see in `results`, or `null`. */
function lastVisibleAuthor(results: unknown[]): SupportMessageAuthor | null {
  for (let index = results.length - 1; index >= 0; index -= 1) {
    const parsed = threadMessageSchema.safeParse(results[index])
    if (!parsed.success || parsed.data.is_private) continue
    if (parsed.data.message_type === 'customer_message') return 'customer'
    if (parsed.data.message_type === 'sent_reply') return 'team'
  }
  return null
}

/**
 * Who wrote the last message the reporter can see on this ticket: the
 * reporter (`customer`, so the team owes the answer) or the team. Notes and AI
 * drafts do not count, because the reporter never got them. `null` for a
 * thread with no such message in its tail. PostHog orders a thread oldest
 * first, so this reads only the last few messages, one call per ticket, and
 * remembers the answer until the ticket changes.
 */
export async function lastVisibleMessageAuthor(
  config: PosthogSupportConfig,
  ticket: Pick<SupportTicket, 'id' | 'updatedAt' | 'messageCount'>,
  fetchImpl: typeof fetch = fetch
): Promise<SupportMessageAuthor | null> {
  const key = `${config.projectId}|${ticket.id}|${ticket.updatedAt}`
  if (lastAuthors.has(key)) return lastAuthors.get(key) ?? null
  const what = 'last message'
  const read = async (offset: number, limit: number) => {
    const response = await send(
      fetchImpl,
      what,
      `${ticketUrl(config, ticket.id)}messages/?limit=${limit}&offset=${offset}`,
      { headers: privateHeaders(config) }
    )
    return parseOrThrow(pageSchema, await jsonOf(response, what), what)
  }
  const known = ticket.messageCount
  const offset = known === null ? 0 : Math.max(0, known - THREAD_TAIL)
  let page = await read(offset, known === null ? THREAD_PAGE_LIMIT : THREAD_TAIL)
  // The thread is longer than the ticket said: read its real tail.
  if (page.count > offset + page.results.length) {
    page = await read(Math.max(0, page.count - THREAD_TAIL), THREAD_TAIL)
  }
  const author = lastVisibleAuthor(page.results)
  rememberLastAuthor(key, author)
  return author
}

/** Assign a ticket to one PostHog user; resolves to the updated ticket. */
export async function assignSupportTicket(
  config: PosthogSupportConfig,
  id: string,
  posthogUserId: number,
  fetchImpl: typeof fetch = fetch
): Promise<SupportTicket> {
  return patchTicket(config, id, { assignee: { type: 'user', id: posthogUserId } }, 'assign ticket', fetchImpl)
}
