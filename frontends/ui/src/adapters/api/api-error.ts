/**
 * API Request Error
 *
 * Error thrown by REST client helpers when the backend (or proxy) returns a
 * non-OK response. Carries the HTTP status code so consumers can classify
 * failures structurally (e.g. 404/410 → resource gone) instead of matching
 * substrings in free-text messages.
 */
export class ApiRequestError extends Error {
  readonly status: number
  /** The server's machine-readable `details.reason`, when it sent one. */
  readonly reason: string | null
  /**
   * The rest of the server's `details` (what the refusal names: ids, terms,
   * counts), when it sent any. Untyped on purpose: each caller reads the keys
   * its route documents, and checks their type.
   */
  readonly details: Readonly<Record<string, unknown>> | null

  constructor(message: string, status: number, reason: string | null = null, details: Readonly<Record<string, unknown>> | null = null) {
    super(message)
    this.status = status
    this.reason = reason
    this.details = details
  }
}
