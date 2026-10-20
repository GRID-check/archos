/**
 * Whether `error` is the signal `redirect()` throws: an error whose digest is
 * `NEXT_REDIRECT;<type>;<url>;<status>;`, the shape Next's own guard reads.
 * That guard is exported only from an internal path (`next/dist/...`), so this
 * reads the shape instead.
 *
 * For a client that awaits a server action which ends in `redirect()`: Next
 * has already navigated when the call rejects with this, and rejects only so a
 * transition's boundary can see it. Awaited from an event handler there is no
 * such boundary, and an unhandled redirect reaches error tracking.
 */
export function isRedirectSignal(error: unknown): boolean {
  if (typeof error !== 'object' || error === null || !('digest' in error)) return false
  const { digest } = error
  return typeof digest === 'string' && digest.startsWith('NEXT_REDIRECT;')
}
