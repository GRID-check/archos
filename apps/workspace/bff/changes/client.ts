/**
 * The browser's client for the change record (ADR-0109): what a turn changed,
 * and undo. Shapes from `./types`.
 */

import {
  turnChangesResponseSchema,
  undoChangeResponseSchema,
  type TurnChangesResponse,
  type UndoChangeResponse,
} from './types'

export class ChangeRequestError extends Error {
  constructor(
    message: string,
    readonly status: number,
    /** The refusal code the server named (`moved-on`, `already-undone`, ...), when it named one. */
    readonly code: string | null
  ) {
    super(message)
    this.name = 'ChangeRequestError'
  }
}

async function request<T>(path: string, init: RequestInit, parse: (body: unknown) => T): Promise<T> {
  const response = await fetch(path, { credentials: 'same-origin', ...init })
  const body: unknown = await response.json().catch(() => null)
  if (!response.ok) {
    const record = (body ?? {}) as { error?: unknown; message?: unknown }
    const code = typeof record.error === 'string' ? record.error : null
    const message = typeof record.message === 'string' ? record.message : `Request failed (${response.status})`
    throw new ChangeRequestError(message, response.status, code)
  }
  return parse(body)
}

/** What the turn behind answer `messageId` in `conversationId` changed, as it stands now. */
export function getTurnChanges(conversationId: string, messageId: string): Promise<TurnChangesResponse> {
  const path = `/api/conversations/${encodeURIComponent(conversationId)}/messages/${encodeURIComponent(messageId)}/changes`
  return request(path, { method: 'GET' }, (body) => turnChangesResponseSchema.parse(body))
}

/** Undo one change as the signed-in person. Throws `ChangeRequestError` (409 `moved-on` / `already-undone`). */
export function undoChange(id: string): Promise<UndoChangeResponse> {
  return request(`/api/piloti-changes/${encodeURIComponent(id)}/undo`, { method: 'POST' }, (body) =>
    undoChangeResponseSchema.parse(body)
  )
}
