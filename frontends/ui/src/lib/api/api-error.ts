/**
 * The base of every typed API error, and the two refusals that vocabulary and
 * parsing modules throw.
 *
 * Its own module so a small module that only refuses input (a status
 * vocabulary, an id or page parser) does not import `errors.ts` and its whole
 * catalogue: every spec that reaches such a leaf would otherwise re-run on any
 * change to `errors.ts` (docs/audit/blast-radius-2026-10.md §7.4). `errors.ts`
 * re-exports all three, so a service imports from there as before. This module
 * imports nothing (`errors-leaf.spec.ts`).
 */

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    /** Optional machine-readable details, serialized at the envelope top level. */
    readonly details?: unknown
  ) {
    super(message)
    this.name = new.target.name
  }
}

/** 400 — malformed input (bad JSON, schema violations, invalid params). */
export class BadRequestError extends ApiError {
  constructor(message = 'Bad request', details?: unknown) {
    super(400, 'BAD_REQUEST', message, details)
  }
}

/** 403 — authenticated but not allowed. */
export class ForbiddenError extends ApiError {
  constructor(message = 'Forbidden', details?: unknown) {
    super(403, 'FORBIDDEN', message, details)
  }
}
