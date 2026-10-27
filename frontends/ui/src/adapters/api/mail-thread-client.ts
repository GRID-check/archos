/**
 * The E-Mail-Verlauf's client (ADR-0134, ADR-0055): the typed browser door to
 * the `mail-thread-*` routes the agent operations name
 * (`lib/agent-api/catalog/mail.ts`), so the „E-Mails“ tab and an agent are two
 * clients of one API.
 *
 *   - threads   → `/api/projects/[id]/mail-threads` (list), `…/[threadId]` (get)
 *   - follow    → `…/[threadId]/follow` (POST follows or renews, DELETE ends; `?userId` ends someone else's)
 *   - detach    → `…/[threadId]/entries/[entryId]/detach` (POST)
 *   - original  → `…/[threadId]/entries/[entryId]/original` (a link, fetched by `downloadFetched`, never here)
 *
 * The shapes are the wire module's (`lib/mail-thread/mail-thread-wire.ts`),
 * imported, never restated. A refusal arrives as {@link ApiRequestError} with
 * the server's code in `reason` (`MAIL_THREAD_REFUSALS`, or `project-closed`
 * on a follow), which the UI words.
 */

import type {
  MailThreadEntryDetachBody,
  MailThreadEntryDetachResultView,
  MailThreadFollowBody,
  MailThreadFollowResultView,
  MailThreadUnfollowResultView,
} from '@/lib/mail-thread/mail-thread-wire'
import { ApiRequestError } from './api-error'

// The two reads were written with the E-Mail-Eingang's client, which files
// into threads; they are the same routes, offered here so a caller of the
// thread has one door.
export { getMailThread, listMailThreads } from './inbound-mail-client'

const enc = encodeURIComponent
const threadBase = (projectId: string, threadId: string) => `/api/projects/${enc(projectId)}/mail-threads/${enc(threadId)}`
const entryBase = (projectId: string, threadId: string, entryId: string) => `${threadBase(projectId, threadId)}/entries/${enc(entryId)}`

/** The server's refusal as an error: its message, status, `details.reason` and the rest of `details` (`upload_refused`'s `failure`). */
async function requestError(response: Response, fallback: string): Promise<ApiRequestError> {
  const body: unknown = await response.json().catch(() => null)
  const envelope = (body ?? {}) as { error?: unknown; details?: unknown }
  const message = typeof envelope.error === 'string' && envelope.error ? envelope.error : `${fallback}: ${response.status}`
  const details =
    envelope.details && typeof envelope.details === 'object' && !Array.isArray(envelope.details)
      ? (envelope.details as Record<string, unknown>)
      : null
  const reason = typeof details?.reason === 'string' ? details.reason : null
  return new ApiRequestError(message, response.status, reason, details)
}

async function request<T>(url: string, fallback: string, init: RequestInit): Promise<T> {
  const response = await fetch(url, init)
  if (!response.ok) throw await requestError(response, fallback)
  return (await response.json()) as T
}

const postJson = (body: unknown): RequestInit => ({
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
})

/**
 * „Diesem E-Mail-Verlauf folgen“ (D31), or „Verlängern“: called again while a
 * follow runs, it renews it (`renewed: true`), never past 180 days from its start.
 */
export function followMailThread(
  projectId: string,
  threadId: string,
  body: MailThreadFollowBody = {},
): Promise<MailThreadFollowResultView> {
  return request(`${threadBase(projectId, threadId)}/follow`, 'Failed to follow the mail thread', postJson(body))
}

/**
 * End a follow: the caller's own, or, with `userId`, someone else's (the
 * server asks `project:manage` for that). Ending one that is not running
 * answers `endedFollowId: null`, so an undo can call it blindly.
 */
export function unfollowMailThread(
  projectId: string,
  threadId: string,
  options: { userId?: string } = {},
): Promise<MailThreadUnfollowResultView> {
  const search = options.userId ? `?${new URLSearchParams({ userId: options.userId }).toString()}` : ''
  return request(`${threadBase(projectId, threadId)}/follow${search}`, 'Failed to end the follow', { method: 'DELETE' })
}

/** Take one filed message out of its thread, into another or a new one (D34). */
export function detachMailThreadEntry(
  projectId: string,
  threadId: string,
  entryId: string,
  body: MailThreadEntryDetachBody,
): Promise<MailThreadEntryDetachResultView> {
  return request(`${entryBase(projectId, threadId, entryId)}/detach`, 'Failed to detach the mail', postJson(body))
}

/** Where a filed message's original `.eml` is downloaded, scanned whole on each request (409 `original_not_clean`, `gone`). */
export function mailThreadEntryOriginalUrl(projectId: string, threadId: string, entryId: string): string {
  return `${entryBase(projectId, threadId, entryId)}/original`
}
