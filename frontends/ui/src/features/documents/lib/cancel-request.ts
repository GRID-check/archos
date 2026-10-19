/**
 * One request to stop a running ingest, and what came of it.
 *
 * Shared by the document menu's „Lesen abbrechen" and the upload tray's stop,
 * so the two read the server's answer the same way. The server answers
 * `{ result }` (`@/lib/documents/service`): a stop it made, a job that had
 * already finished, or work it cannot reach from where it stands.
 */

export type CancelIngestOutcome =
  /** A live job was stopped; the row is `cancelled`. */
  | { kind: 'cancelled' }
  /** The durable queue held no live job: it had already run to an end. */
  | { kind: 'finished' }
  /** Nothing this tier can stop: the durable ingest queue is off, or the work runs inside the BFF. */
  | { kind: 'unavailable' }
  /** The request itself failed (transport, or a 5xx). */
  | { kind: 'failed' }

export async function requestCancelIngest(documentId: string): Promise<CancelIngestOutcome> {
  try {
    const res = await fetch(`/api/documents/${encodeURIComponent(documentId)}/cancel`, { method: 'POST' })
    if (!res.ok) return { kind: 'failed' }
    const data: unknown = await res.json().catch(() => null)
    const result = data !== null && typeof data === 'object' ? (data as { result?: unknown }).result : null
    if (result === 'cancelled' || result === 'finished' || result === 'unavailable') return { kind: result }
    return { kind: 'failed' }
  } catch {
    return { kind: 'failed' }
  }
}
