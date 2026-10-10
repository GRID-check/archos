/**
 * Server request errors to PostHog error tracking (ADR-0099).
 *
 * Next.js calls `onRequestError` (exported from `instrumentation.ts`) for every
 * error it catches while rendering a page, running a route handler, a server
 * action or the proxy. This module decides what of that reaches PostHog and in
 * what shape; `instrumentation.ts` only forwards, because the file also loads
 * in the Edge runtime where `posthog-node` does not run.
 *
 * Three decisions live here rather than at the call site:
 *
 * - **Authorization denials are not errors.** `requireProjectAccess` throws a
 *   plain `Error('Not found')` on a permission denial, and the same signal
 *   routes the visitor to the access screen (`isAuthzError`). Counted as
 *   exceptions they would be most of the free tier's 100K a month and none of
 *   its value.
 * - **A hot route cannot burn the free tier.** A failing page that every
 *   client retries is the same exception thousands of times. Each fingerprint
 *   (route, error name, message) is allowed a handful per window; the rest are
 *   dropped, and the first of them leaves one console line so the drop is not
 *   invisible.
 * - **No identity lookup.** The distinct id is the WorkOS user id, but reading
 *   it means decrypting the session cookie through WorkOS, which an error path
 *   must not start. The request headers carry only the sealed session, so the
 *   event is personless (`null`); the browser's own `$exception` for the same
 *   incident is identified.
 */
import 'server-only'

import type { Instrumentation } from 'next'

import { isAuthzError } from '@/lib/auth-utils'
import { deployedSha } from '@/lib/boot'

import { captureServerException } from './posthog-server'

type RequestInfo = Parameters<Instrumentation.onRequestError>[1]
type RequestContext = Parameters<Instrumentation.onRequestError>[2]

/** Events allowed per fingerprint per window. */
export const REQUEST_ERROR_BURST = 5
export const REQUEST_ERROR_WINDOW_MS = 5 * 60_000
/** Distinct fingerprints remembered; the oldest is forgotten past this. */
const MAX_FINGERPRINTS = 500
const MESSAGE_FINGERPRINT_LENGTH = 120

const windows = new Map<string, { startedAt: number; count: number }>()

const fingerprintOf = (error: unknown, context: RequestContext): string => {
  const name = error instanceof Error ? error.name : typeof error
  const message = error instanceof Error ? error.message : String(error)
  return `${context.routePath}|${name}|${message.slice(0, MESSAGE_FINGERPRINT_LENGTH)}`
}

/** Whether this fingerprint still has room in its window; counts the attempt. */
const withinBudget = (key: string, now: number): boolean => {
  const current = windows.get(key)
  if (!current || now - current.startedAt >= REQUEST_ERROR_WINDOW_MS) {
    if (!current && windows.size >= MAX_FINGERPRINTS) {
      const oldest = windows.keys().next().value
      if (oldest !== undefined) windows.delete(oldest)
    }
    windows.set(key, { startedAt: now, count: 1 })
    return true
  }
  current.count += 1
  if (current.count === REQUEST_ERROR_BURST + 1) {
    console.warn('[posthog] request error rate-limited:', key.slice(0, 160))
  }
  return current.count <= REQUEST_ERROR_BURST
}

const digestOf = (error: unknown): string | undefined => {
  if (typeof error !== 'object' || error === null || !('digest' in error)) return undefined
  return String(error.digest)
}

/** The path without its query string: a query can carry a token or a search term. */
const pathWithoutQuery = (path: string): string => path.split('?')[0] ?? path

/**
 * Report one Next.js request error. Returns whether it was queued; never
 * throws, because it runs on the error path of a request that already failed.
 */
export const reportRequestError = (
  error: unknown,
  request: Readonly<RequestInfo>,
  context: Readonly<RequestContext>,
  now: number = Date.now(),
): boolean => {
  if (isAuthzError(error)) return false
  if (!withinBudget(fingerprintOf(error, context), now)) return false
  return captureServerException(error, null, {
    source: 'bff-on-request-error',
    route_path: context.routePath,
    route_type: context.routeType,
    router_kind: context.routerKind,
    render_source: context.renderSource ?? null,
    request_method: request.method,
    request_path: pathWithoutQuery(request.path),
    digest: digestOf(error) ?? null,
    release: deployedSha(),
    service: process.env.OTEL_SERVICE_NAME ?? 'grid-ui',
  })
}

/** Forget every fingerprint so a spec starts with a full budget. */
export const resetRequestErrorLimiterForTests = (): void => {
  windows.clear()
}
