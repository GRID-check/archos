/**
 * A dependency failure the BFF answered itself, to PostHog error tracking.
 *
 * `onRequestError` (`request-error.ts`) only sees errors Next.js catches. An
 * `UpstreamError` never gets that far: `errorResponse` turns it into a 502, so
 * an object store that refused every new organization's first upload
 * (2026-10-20) reached the user and nothing else. This is the capture for that
 * case, called from `errorResponse`.
 *
 * Personless, with the same scrubber and super properties as every BFF event
 * (the shared client carries both), and rate limited per fingerprint like
 * `request-error.ts`, so an outage that every client retries costs a burst per
 * window rather than the free tier.
 */
import 'server-only'

import type { UpstreamError } from '@/lib/api/errors'

import { getPosthogServer } from './posthog-server'

/**
 * The same budget as `request-error.ts` (5 per fingerprint per 5 minutes),
 * counted here rather than with `@posthog/core`'s `BucketedRateLimiter`: only
 * `request-error.ts` may import a PostHog package beside the two clients
 * (`tests/test_posthog_boundaries.py`), and a fixed window is a few lines.
 */
export const UPSTREAM_ERROR_BURST = 5
const UPSTREAM_ERROR_WINDOW_MS = 5 * 60_000

let windows = new Map<string, { startedAt: number; count: number }>()

/** Whether this fingerprint has spent its burst in the current window. */
const isRateLimited = (fingerprint: string, now: number): boolean => {
  const window = windows.get(fingerprint)
  if (!window || now - window.startedAt >= UPSTREAM_ERROR_WINDOW_MS) {
    windows.set(fingerprint, { startedAt: now, count: 1 })
    return false
  }
  window.count += 1
  if (window.count === UPSTREAM_ERROR_BURST + 1) {
    console.warn('[posthog] upstream error rate-limited:', fingerprint.slice(0, 160))
  }
  return window.count > UPSTREAM_ERROR_BURST
}

/** What an upstream error's details may say about itself; anything else is ignored. */
export interface UpstreamContext {
  operation?: string
  code?: string
}

/** `operation` and `code` from the thrower's details, when it put strings there. */
export const upstreamContext = (error: UpstreamError): UpstreamContext => {
  const details = (error.details ?? {}) as { operation?: unknown; code?: unknown }
  return {
    ...(typeof details.operation === 'string' ? { operation: details.operation } : {}),
    ...(typeof details.code === 'string' ? { code: details.code } : {}),
  }
}

/** Queue the exception; whether it was queued. Never throws. */
export const captureUpstreamError = (error: UpstreamError, requestId: string): boolean => {
  const posthog = getPosthogServer()
  if (!posthog) return false
  const context = upstreamContext(error)
  if (isRateLimited(`${error.message}|${context.code ?? ''}`, Date.now())) return false
  try {
    posthog.captureException(error, undefined, {
      source: 'bff-upstream-error',
      request_id: requestId,
      ...context,
    })
    return true
  } catch (failure) {
    console.debug('[posthog] could not queue an upstream error', failure)
    return false
  }
}

export const resetUpstreamErrorLimiterForTests = (): void => {
  windows = new Map()
}
