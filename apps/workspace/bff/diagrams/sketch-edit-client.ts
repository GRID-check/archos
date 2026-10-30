/**
 * The browser's client for a Skizze edit (S4): the preview a receipt draws,
 * the current Fassung it compares its own against, and the revert behind
 * „Rückgängig“. Paths and shapes written once (ADR-0055); the routes are
 * `app/api/documents/[id]/sketch/edits/preview`, `…/sketch?probe=1` and
 * `…/sketch/revert`.
 *
 * No `server-only`: the browser imports this.
 */

import type { SketchEditBody, SketchEditPreview } from './sketch-edit-wire'
import type { SavedSketch, SketchProbe } from './sketch-wire'

export type SketchFetch = (path: string, init?: RequestInit) => Promise<Response>

const defaultFetch: SketchFetch = (path, init) => fetch(path, init)

/** A request the route refused, with its status and the reason its details name (`moved_on`). */
export class SketchEditRequestError extends Error {
  constructor(
    readonly status: number,
    readonly reason: string | null
  ) {
    super(`sketch edit request failed (${status}${reason ? `, ${reason}` : ''})`)
    this.name = 'SketchEditRequestError'
  }
}

const sketchPath = (documentId: string) => `/api/documents/${encodeURIComponent(documentId)}/sketch`

async function json<T>(response: Response): Promise<T> {
  if (response.ok) return (await response.json()) as T
  const body = (await response.json().catch(() => null)) as { details?: { reason?: unknown } } | null
  const reason = body?.details?.reason
  throw new SketchEditRequestError(response.status, typeof reason === 'string' ? reason : null)
}

const post = (body: unknown): RequestInit => ({
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
})

/** The edit drawn on the Fassung it was made on: the diff, the warnings and the picture. */
export function fetchSketchEditPreview(documentId: string, body: SketchEditBody, run: SketchFetch = defaultFetch): Promise<SketchEditPreview> {
  return run(`${sketchPath(documentId)}/edits/preview`, post(body)).then((response) => json<SketchEditPreview>(response))
}

/** The Skizze's current Fassung, without reading the drawing (`?probe=1`). */
export function fetchSketchProbe(documentId: string, run: SketchFetch = defaultFetch): Promise<SketchProbe> {
  return run(`${sketchPath(documentId)}?probe=1`).then((response) => json<SketchProbe>(response))
}

/** Take back `versionId`, the current Fassung: the one before it becomes the next. 409 `moved_on` when it is not current. */
export function revertSketchVersion(documentId: string, versionId: string, run: SketchFetch = defaultFetch): Promise<SavedSketch> {
  return run(`${sketchPath(documentId)}/revert`, post({ versionId })).then((response) => json<SavedSketch>(response))
}
