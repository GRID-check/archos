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
  /** The ticket in the PostHog app. */
  url: string
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
  /** Personal API key with `ticket:read` and `ticket:write` (and `project:read` for the widget token). */
  personalApiKey: string
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
   * The reporter's browser widget session, so replies show in their widget.
   * `null` when the browser had none (PostHog off or blocked there): the
   * server makes one up and the ticket is still triageable, only not
   * answerable through the widget.
   */
  widgetSessionId: string | null
  /** The reporter's PostHog session, so the ticket links the replay. */
  sessionId: string | null
  tags: string[]
}
