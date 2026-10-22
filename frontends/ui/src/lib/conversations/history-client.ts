/**
 * Reading a thread's whole history through the paged messages route: the
 * newest page first, then the pages before it, up to what the chat window
 * restores. Every browser reader of `GET /api/conversations/[id]/messages`
 * goes through this, so none of them meets a page boundary the others do not.
 *
 * No `server-only`: the browser imports this.
 */

import type { MessageListResponse, MessageView } from './message-view'

/** Messages per request. */
const HISTORY_PAGE = 200
/** The most messages of one thread the chat window restores. */
const HISTORY_MESSAGES_MAX = 1000

export type ThreadHistory = { ok: true; messages: MessageView[] } | { ok: false; response: Response }

export async function fetchThreadHistory(
  conversationId: string,
  run: (url: string) => Promise<Response> = (url) => fetch(url)
): Promise<ThreadHistory> {
  const history: MessageView[] = []
  let cursor: string | null = null
  do {
    const params = new URLSearchParams({ limit: String(HISTORY_PAGE), include: 'citations,steps,metadata' })
    if (cursor) params.set('cursor', cursor)
    const response = await run(`/api/conversations/${encodeURIComponent(conversationId)}/messages?${params.toString()}`)
    if (!response.ok) return { ok: false, response }
    const page = (await response.json()) as MessageListResponse
    history.unshift(...page.messages)
    cursor = history.length < HISTORY_MESSAGES_MAX ? page.nextCursor : null
  } while (cursor)
  return { ok: true, messages: history }
}
