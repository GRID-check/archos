/**
 * Next.js control flow is not an error. `redirect()`, `permanentRedirect()`,
 * `notFound()`, `forbidden()` and `unauthorized()` work by throwing; the
 * framework catches the throw and navigates. A capture path that sees one
 * (a boundary, `window.onunhandledrejection` when a server action's promise
 * rejects with its redirect, `onRequestError`) must drop it, or every sign-in
 * bounce becomes an issue named `Error: NEXT_REDIRECT`.
 *
 * Next marks them by `digest` (`NEXT_REDIRECT;…`, `NEXT_NOT_FOUND`,
 * `NEXT_HTTP_ERROR_FALLBACK;<status>`), and a redirect that crossed the
 * server-action boundary arrives as a bare `Error('NEXT_REDIRECT')` whose
 * message is the marker. No `server-only` import: the browser facade uses it too.
 */
const CONTROL_FLOW_MARKERS = ['NEXT_REDIRECT', 'NEXT_NOT_FOUND', 'NEXT_HTTP_ERROR_FALLBACK'] as const

const isMarker = (text: unknown): boolean =>
  typeof text === 'string' &&
  CONTROL_FLOW_MARKERS.some((marker) => text === marker || text.startsWith(`${marker};`))

export function isFrameworkControlFlow(error: unknown): boolean {
  if (typeof error === 'string') return isMarker(error)
  if (typeof error !== 'object' || error === null) return false
  const { digest, message } = error as { digest?: unknown; message?: unknown }
  return isMarker(digest) || isMarker(message)
}

/** The slice of a PostHog `$exception` event this reads. */
interface ExceptionEventProperties {
  $exception_list?: Array<{ value?: unknown }>
  $exception_message?: unknown
}

/** Whether a captured `$exception` event is framework control flow (the autocapture path, which only has the serialised event). */
export function isControlFlowExceptionEvent(
  event: string,
  properties: ExceptionEventProperties | undefined
): boolean {
  if (event !== '$exception' || !properties) return false
  if (isMarker(properties.$exception_message)) return true
  return (properties.$exception_list ?? []).some((entry) => isMarker(entry?.value))
}
