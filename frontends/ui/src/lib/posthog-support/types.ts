/**
 * PostHog Support, as the BFF sees it: the ticket shape this app reads and the
 * configuration that lets the server talk to PostHog's private API.
 *
 * No `'server-only'`: the platform triage page imports the status vocabulary.
 * The configuration itself is only ever built on the server
 * (`posthogSupportConfigFromEnv` in `./config`), because it carries the
 * personal API key.
 */

/** PostHog's own ticket statuses, verbatim. Triage happens in these. */
export const SUPPORT_TICKET_STATUSES = ['new', 'open', 'pending', 'on_hold', 'resolved'] as const
export type SupportTicketStatus = (typeof SUPPORT_TICKET_STATUSES)[number]

/**
 * The tag every ticket opened for a product-feedback report carries. The
 * platform page lists PostHog tickets with this tag and nothing else, so a
 * ticket somebody opened through the widget by hand stays out of it.
 */
export const FEEDBACK_TICKET_TAG = 'piloti-feedback'

/** Tag on a ticket whose reporter did not agree to be contacted: read it, never reply. */
export const NO_CONTACT_TICKET_TAG = 'no-contact'

/** `kind:bug`, `kind:idea`, … — the report's kind, filterable in PostHog. */
export const kindTicketTag = (kind: string): string => `kind:${kind}`

/** The statuses of a case that is still being worked on: everything but `resolved`. */
export const ACTIVE_SUPPORT_TICKET_STATUSES = ['new', 'open', 'pending', 'on_hold'] as const satisfies readonly SupportTicketStatus[]

/**
 * Who a ticket is assigned to, as PostHog serves it: a PostHog user (with the
 * email of their PostHog login) or a role. PostHog's list carries no name; the
 * members list does (`listPosthogMembers`).
 */
export type SupportTicketAssignee =
  | { type: 'user'; id: number; email: string | null }
  | { type: 'role'; id: string; name: string | null }

/** One Support ticket, reduced to what the app reads. */
export interface SupportTicket {
  /** PostHog's ticket UUID. */
  id: string
  /** The human number PostHog shows (`#42`), when the response carries it. */
  ticketNumber: number | null
  status: SupportTicketStatus
  tags: string[]
  createdAt: string
  updatedAt: string
  /** `null` while nobody has the ticket. */
  assignee: SupportTicketAssignee | null
  /**
   * When the last message was written, falling back to `updatedAt` when the
   * response carries no `last_message_at`.
   */
  lastActivityAt: string
  /** Messages on the thread, notes included, when PostHog says. */
  messageCount: number | null
  /** The reporter's messages the team has not read yet. */
  unreadTeamCount: number
  /** The ticket in the PostHog app. */
  url: string
}

/** One member of the PostHog organization, for naming a ticket's assignee. */
export interface PosthogMember {
  id: number
  email: string
  /** First and last name as PostHog holds them; `null` when both are empty. */
  name: string | null
}

export interface SupportTicketPage {
  tickets: SupportTicket[]
  /** Total matching the filter, as PostHog counts it. */
  count: number
}

/**
 * Everything the server needs to open, list and update tickets. `null` from
 * the config reader means Support is not configured in this deployment: the
 * platform page then shows the local log only.
 */
export interface PosthogSupportConfig {
  /** PostHog app host for the private API and links, e.g. `https://eu.posthog.com`. */
  appHost: string
  /** Ingestion host the widget endpoint lives on, e.g. `https://eu.i.posthog.com`. */
  ingestHost: string
  /** Numeric project id (`/api/projects/:project_id/...`). */
  projectId: string
  /**
   * The public project token (`phc_…`), which names the project's public remote
   * config, where the Support widget token is read without any key.
   */
  projectToken: string
  /** Personal API key with `ticket:read` and `ticket:write`. */
  personalApiKey: string
  /**
   * This app's own origin (`https://app.piloti.at`), sent as `Origin` when the
   * server opens a ticket. PostHog checks every conversations call against the
   * project's Allowed domains, and a server request carries no Origin of its
   * own; `null` when the deployment does not pin one.
   */
  appOrigin: string | null
}

/** Thrown when PostHog cannot be reached or refuses; callers fall back to the local log. */
export class PosthogSupportUnavailableError extends Error {
  constructor(
    message: string,
    readonly status: number | null = null
  ) {
    super(message)
    this.name = 'PosthogSupportUnavailableError'
  }
}

/** What opening a ticket for one report needs. */
export interface OpenFeedbackTicketInput {
  /** The first message: `[<kind>] #<report id> <page>` then the masked text. */
  message: string
  /** The reporter's PostHog distinct id: the WorkOS user id. */
  distinctId: string
  /**
   * The conversations session the ticket is opened in, made up by the server
   * per report and stored with it: the reporter's later replies must come from
   * the same session to land on the same ticket.
   */
  widgetSessionId: string
  /** The reporter's PostHog session, so the ticket links the replay. */
  sessionId: string | null
  tags: string[]
}

/** What a reporter's reply on their own ticket needs. */
export interface CustomerReplyInput {
  ticketId: string
  /** The session the ticket was opened in (`product_feedback.posthog_widget_session_id`). */
  widgetSessionId: string
  distinctId: string
  /** Already masked. */
  message: string
}

/**
 * Who wrote a message the reporter may see: the reporter themselves, or the
 * team (a person, a workflow or PostHog's AI, sent as a reply).
 */
export type SupportMessageAuthor = 'customer' | 'team'

/**
 * One message of a ticket's thread as the reporter sees it. Internal notes and
 * AI drafts are never in this shape: the client drops them.
 */
export interface SupportMessage {
  id: string
  author: SupportMessageAuthor
  /** The team member's display name; `null` for the reporter and for unnamed senders. */
  authorName: string | null
  content: string
  createdAt: string
}
