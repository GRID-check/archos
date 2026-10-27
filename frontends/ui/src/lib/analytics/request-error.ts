/**
 * Server request errors to PostHog error tracking, through `@posthog/next` (ADR-0100).
 *
 * Next.js calls `onRequestError` (exported from `instrumentation.ts`) for every
 * error it catches while rendering a page, running a route handler, a server
 * action or the proxy. PostHog's Next.js package does the capture: it builds
 * the `$exception` with the route, method, digest and the path without its
 * query, reads the visitor's PostHog cookie for their distinct id and session
 * (so a server error lands on the same person and replay as the browser's), and
 * honours the opt-out cookie. What stays here is our configuration of it, which
 * `instrumentation.ts` cannot hold because it also loads in the Edge runtime:
 *
 * - **The same settings and scrubber as every other BFF event.** The host and
 *   token are the ones `posthog-server.ts` reads, at runtime (the image is built
 *   without them), and the client the package builds gets `scrubServerEvent` as
 *   its `before_send` and no GeoIP. The package's client sends each exception
 *   immediately, so there is no queue for the shutdown hook to flush.
 * - **Authorization denials are not errors.** `requireProjectAccess` throws a
 *   `NotFoundError` on a permission denial, and a refusal (401, 403 or 404,
 *   `isAuthzRefusal`) routes the visitor to the access screen. Counted as
 *   exceptions they would be most of the free tier's 100K a month and none of
 *   its value.
 * - **A form post naming no action we have is not an error either.** Next
 *   throws "Failed to find Server Action" when a non-fetch multipart POST
 *   carries action ids this build does not know, and answers it with a 404. Our
 *   client calls every action by fetch, so what reaches that branch is a probe
 *   for the server-action endpoint (they arrive in bursts, each with a fresh
 *   distinct id and no session), or a form rendered by another build. Neither
 *   is a defect we can fix, and a probe sweep would spend the free tier.
 * - **A hot route cannot burn the free tier.** A failing page that every
 *   client retries is the same exception thousands of times. Each fingerprint
 *   (route, error name, message) gets a burst per window from PostHog's own
 *   `BucketedRateLimiter`; the rest are dropped, and the first drop leaves one
 *   console line so it is not invisible.
 *
 * The package is pre-release (pinned to an exact version in `package.json`).
 * Its root export resolves `createOnRequestError` only under the `react-server`
 * condition, which Next applies to everything the instrumentation layer
 * imports; a plain Node import gets the browser build without it.
 */
import 'server-only'

import { BucketedRateLimiter, type Logger } from '@posthog/core'
import {
  createOnRequestError,
  type NextOnRequestError,
  type OnRequestErrorBeforeCaptureContext,
  type OnRequestErrorOptions,
} from '@posthog/next'

import { isAuthzRefusal } from '@/lib/api/errors'

import { posthogServerSettings, serverSuperProperties } from './posthog-server'
import { scrubServerEvent } from './scrub-server-event'

/** Events allowed per fingerprint per window. */
export const REQUEST_ERROR_BURST = 5
export const REQUEST_ERROR_WINDOW_MS = 5 * 60_000
const MESSAGE_FINGERPRINT_LENGTH = 120
/** How Next's action handler opens the message for an action id this build lacks. */
const UNKNOWN_ACTION_MESSAGE = 'Failed to find Server Action.'

const quietLogger: Logger = {
  debug: () => {},
  info: () => {},
  warn: (...args: unknown[]) => console.warn('[posthog]', ...args),
  error: (...args: unknown[]) => console.error('[posthog]', ...args),
  critical: (...args: unknown[]) => console.error('[posthog]', ...args),
  createLogger: () => quietLogger,
}

/**
 * The limiter empties a bucket on the call that takes its last token, so a
 * bucket one larger than the burst admits exactly the burst, and a full refill
 * per window makes it a fixed window of `REQUEST_ERROR_BURST`.
 */
const newLimiter = (): BucketedRateLimiter<string> =>
  new BucketedRateLimiter<string>({
    bucketSize: REQUEST_ERROR_BURST + 1,
    refillRate: REQUEST_ERROR_BURST + 1,
    refillInterval: REQUEST_ERROR_WINDOW_MS,
    _logger: quietLogger,
    _onBucketRateLimited: (key) =>
      console.warn('[posthog] request error rate-limited:', key.slice(0, 160)),
  })

let limiter = newLimiter()
let handler: NextOnRequestError | null = null

const fingerprintOf = ({ error, context }: OnRequestErrorBeforeCaptureContext): string => {
  const name = error instanceof Error ? error.name : typeof error
  const message = error instanceof Error ? error.message : String(error)
  return `${context.routePath ?? ''}|${name}|${message.slice(0, MESSAGE_FINGERPRINT_LENGTH)}`
}

const isUnknownActionError = (error: unknown): boolean =>
  error instanceof Error && error.message.startsWith(UNKNOWN_ACTION_MESSAGE)

/**
 * The package's `beforeCapture`: `false` skips the capture, an object is
 * merged into the event's properties.
 */
export const beforeCapture = (
  capture: OnRequestErrorBeforeCaptureContext
): Record<string, unknown> | false => {
  if (isAuthzRefusal(capture.error)) return false
  if (isUnknownActionError(capture.error)) return false
  if (limiter.consumeRateLimit(fingerprintOf(capture))) return false
  // The package's client is not ours to `register` on, so the super
  // properties every other server event carries travel per event here.
  return { source: 'bff-on-request-error', ...serverSuperProperties() }
}

/** What `createOnRequestError` is built with; `null` while PostHog is off. */
export const requestErrorOptions = (): OnRequestErrorOptions | null => {
  const settings = posthogServerSettings()
  if (!settings) return null
  return {
    apiKey: settings.projectToken,
    host: settings.host,
    serverOptions: { disableGeoip: true, before_send: scrubServerEvent },
    beforeCapture,
  }
}

/** The process-wide handler, built on the first error; `null` while PostHog is off. */
export const requestErrorHandler = (): NextOnRequestError | null => {
  if (handler) return handler
  const options = requestErrorOptions()
  if (!options) return null
  handler = createOnRequestError(options)
  return handler
}

/** Forget the handler and every fingerprint so a spec starts fresh. */
export const resetRequestErrorHandlerForTests = (): void => {
  handler = null
  limiter = newLimiter()
}
