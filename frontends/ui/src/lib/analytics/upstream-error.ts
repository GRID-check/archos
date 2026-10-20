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

import { BucketedRateLimiter, type Logger } from '@posthog/core'

import type { UpstreamError } from '@/lib/api/errors'

import { getPosthogServer } from './posthog-server'

/**
 * The same budget as `request-error.ts`, written out rather than imported: that
 * module pulls `@posthog/next` in, and this one is loaded by every API route.
 */
export const UPSTREAM_ERROR_BURST = 5
const UPSTREAM_ERROR_WINDOW_MS = 5 * 60_000

const quietLogger: Logger = {
  debug: () => {},
  info: () => {},
  warn: (...args: unknown[]) => console.warn('[posthog]', ...args),
  error: (...args: unknown[]) => console.error('[posthog]', ...args),
  critical: (...args: unknown[]) => console.error('[posthog]', ...args),
  createLogger: () => quietLogger,
}

const newLimiter = (): BucketedRateLimiter<string> =>
  new BucketedRateLimiter<string>({
    bucketSize: UPSTREAM_ERROR_BURST + 1,
    refillRate: UPSTREAM_ERROR_BURST + 1,
    refillInterval: UPSTREAM_ERROR_WINDOW_MS,
    _logger: quietLogger,
    _onBucketRateLimited: (key) => console.warn('[posthog] upstream error rate-limited:', key.slice(0, 160)),
  })

let limiter = newLimiter()

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
  if (limiter.consumeRateLimit(`${error.message}|${context.code ?? ''}`)) return false
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
  limiter = newLimiter()
}
