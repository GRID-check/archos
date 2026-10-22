/**
 * Browser-side client for product feedback. The form and the platform triage
 * page call these; nothing else in the browser talks to the routes directly.
 */

import type {
  OwnProductFeedbackListResponse,
  OwnProductFeedbackThread,
  ProductFeedbackContext,
  ProductFeedbackAssigneeFilter,
  ProductFeedbackKind,
  ProductFeedbackListResponse,
  ProductFeedbackReportView,
  ProductFeedbackStatusFilter,
  SubmittedProductFeedbackView,
  SupportTicketStatus,
} from './types'

export interface SubmitProductFeedbackRequest {
  kind: ProductFeedbackKind
  message: string
  pagePath: string | null
  allowContact: boolean
  context: ProductFeedbackContext
  /** This browser's PostHog replay session, so the Support ticket links the recording. */
  posthog: { sessionId: string | null }
}

export type SubmitProductFeedbackResult =
  | { ok: true; report: SubmittedProductFeedbackView }
  | { ok: false; reason: 'rate-limited' | 'failed' }

export async function submitProductFeedback(
  request: SubmitProductFeedbackRequest
): Promise<SubmitProductFeedbackResult> {
  try {
    const response = await fetch('/api/feedback/reports', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(request),
    })
    if (response.status === 429) return { ok: false, reason: 'rate-limited' }
    if (!response.ok) return { ok: false, reason: 'failed' }
    return { ok: true, report: (await response.json()) as SubmittedProductFeedbackView }
  } catch {
    return { ok: false, reason: 'failed' }
  }
}

/**
 * What the browser can tell a triager without the reporter typing it. Read at
 * send time so it describes the moment of the report, and never the query
 * string or host — a path is enough to find the page, and a query can carry
 * anything.
 */
export function captureFeedbackContext(): { pagePath: string | null; context: ProductFeedbackContext } {
  if (typeof window === 'undefined') return { pagePath: null, context: {} }
  const intl = Intl.DateTimeFormat().resolvedOptions()
  return {
    pagePath: window.location.pathname || null,
    context: {
      userAgent: navigator.userAgent.slice(0, 500),
      viewport: `${window.innerWidth}×${window.innerHeight}`,
      locale: navigator.language,
      timeZone: intl.timeZone,
    },
  }
}

export interface ListFeedbackFilters {
  status?: ProductFeedbackStatusFilter
  kind?: ProductFeedbackKind
  assignee?: ProductFeedbackAssigneeFilter
  cursor?: string | null
}

export async function fetchPlatformFeedback(
  filters: ListFeedbackFilters
): Promise<ProductFeedbackListResponse> {
  const params = new URLSearchParams()
  if (filters.status) params.set('status', filters.status)
  if (filters.kind) params.set('kind', filters.kind)
  if (filters.assignee) params.set('assignee', filters.assignee)
  if (filters.cursor) params.set('cursor', filters.cursor)
  const query = params.toString()
  const response = await fetch(`/api/platform/feedback${query ? `?${query}` : ''}`, {
    credentials: 'same-origin',
  })
  if (!response.ok) throw new Error(`feedback list failed: ${response.status}`)
  return (await response.json()) as ProductFeedbackListResponse
}

export async function fetchPlatformFeedbackReport(id: string): Promise<ProductFeedbackReportView | null> {
  const response = await fetch(`/api/platform/feedback/${encodeURIComponent(id)}`, {
    credentials: 'same-origin',
  })
  if (response.status === 404) return null
  if (!response.ok) throw new Error(`feedback report failed: ${response.status}`)
  return (await response.json()) as ProductFeedbackReportView
}

export async function triagePlatformFeedback(
  id: string,
  status: SupportTicketStatus
): Promise<ProductFeedbackReportView> {
  const response = await fetch(`/api/platform/feedback/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ status }),
  })
  if (!response.ok) throw new Error(`triage failed: ${response.status}`)
  return (await response.json()) as ProductFeedbackReportView
}

/** Assign a feedback ticket to the signed-in platform owner in PostHog. */
export async function claimPlatformFeedbackTicket(ticketId: string): Promise<ProductFeedbackReportView> {
  const response = await fetch('/api/platform/feedback/claim', {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ticketId }),
  })
  if (!response.ok) throw new Error(`claim failed: ${response.status}`)
  return (await response.json()) as ProductFeedbackReportView
}

// ---------------------------------------------------------------------------
// The reporter's own threads
// ---------------------------------------------------------------------------

export async function fetchOwnFeedback(cursor?: string): Promise<OwnProductFeedbackListResponse> {
  const query = cursor ? `?${new URLSearchParams({ cursor }).toString()}` : ''
  const response = await fetch(`/api/feedback/reports${query}`, { credentials: 'same-origin' })
  if (!response.ok) throw new Error(`own feedback failed: ${response.status}`)
  return (await response.json()) as OwnProductFeedbackListResponse
}

/** The office view: every report of the organization. Throws on 403 like any other failure. */
export async function fetchOfficeFeedback(cursor?: string): Promise<OwnProductFeedbackListResponse> {
  const query = cursor ? `?${new URLSearchParams({ cursor }).toString()}` : ''
  const response = await fetch(`/api/feedback/office-reports${query}`, { credentials: 'same-origin' })
  if (!response.ok) throw new Error(`office feedback failed: ${response.status}`)
  return (await response.json()) as OwnProductFeedbackListResponse
}

export async function fetchOwnFeedbackThread(id: string): Promise<OwnProductFeedbackThread> {
  const response = await fetch(`/api/feedback/reports/${encodeURIComponent(id)}/messages`, {
    credentials: 'same-origin',
  })
  if (!response.ok) throw new Error(`feedback thread failed: ${response.status}`)
  return (await response.json()) as OwnProductFeedbackThread
}

export type ReplyToFeedbackResult =
  | { ok: true; thread: OwnProductFeedbackThread }
  | { ok: false; reason: 'rate-limited' | 'failed' }

export async function replyToOwnFeedback(id: string, message: string): Promise<ReplyToFeedbackResult> {
  try {
    const response = await fetch(`/api/feedback/reports/${encodeURIComponent(id)}/messages`, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message }),
    })
    if (response.status === 429) return { ok: false, reason: 'rate-limited' }
    if (!response.ok) return { ok: false, reason: 'failed' }
    return { ok: true, thread: (await response.json()) as OwnProductFeedbackThread }
  } catch {
    return { ok: false, reason: 'failed' }
  }
}
