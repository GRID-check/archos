/**
 * Sending one Web Push message (ADR-0112): the `web-push` library behind a
 * seam that answers in the vocabulary the job needs.
 *
 * `web-push` does the parts that are easy to get subtly wrong and impossible to
 * see failing: the VAPID JWT (RFC 8292), the `aes128gcm` payload encryption
 * (RFC 8188, 8291) and the headers. What it throws is a `WebPushError` carrying
 * the push service's status; this module reads that status once and the job
 * never sees the library. Tests give the job a fake `PushSender`; the library
 * itself is exercised in `sender.spec.ts` against a local HTTPS-less stub.
 */

import 'server-only'
import { parse as legacyParse } from 'node:url'
import webpush, { type PushSubscription } from 'web-push'
import type { PushUrgency } from '@/lib/inbox/push-categories'
import type { WebPushConfig } from './config'
import { isPushServiceEndpoint } from './endpoint'

export interface PushTarget {
  endpoint: string
  p256dh: string
  auth: string
}

export interface PushSendOptions {
  ttlSeconds: number
  urgency: PushUrgency
  /** Replaces an undelivered message with the same topic at the push service. */
  topic: string
}

/**
 * - `delivered`: the push service accepted it (201).
 * - `gone`: 404 or 410, the subscription no longer exists; remove it.
 * - `rejected`: 400, 401, 403, 413 and other final refusals: retrying changes
 *   nothing (a VAPID key that does not match the subscription, a payload too big).
 * - `transient`: 429, 5xx, a timeout or a network error; worth another attempt.
 */
export type PushSendOutcome =
  | { kind: 'delivered' }
  | { kind: 'gone' }
  | { kind: 'rejected'; status: number }
  | { kind: 'transient'; status: number | null }

export interface PushSender {
  send(target: PushTarget, payload: string, options: PushSendOptions): Promise<PushSendOutcome>
}

const SEND_TIMEOUT_MS = 10_000

/** Map a push service's status to what the job does about it. */
export function outcomeForStatus(status: number): PushSendOutcome {
  if (status >= 200 && status < 300) return { kind: 'delivered' }
  if (status === 404 || status === 410) return { kind: 'gone' }
  if (status === 429 || status >= 500) return { kind: 'transient', status }
  return { kind: 'rejected', status }
}

function statusOf(error: unknown): number | null {
  if (typeof error !== 'object' || error === null) return null
  const status = (error as { statusCode?: unknown }).statusCode
  return typeof status === 'number' ? status : null
}

/**
 * Whether the library would request the host we checked. `isPushServiceEndpoint`
 * reads the URL with WHATWG `URL`; `web-push` requests what Node's legacy
 * `url.parse` makes of it. Both must name the same host, or the allow-list
 * vouched for one address and the request goes to another (ADR-0112).
 */
export function isSendableEndpoint(endpoint: string): boolean {
  if (!isPushServiceEndpoint(endpoint)) return false
  // Deprecated, and exactly why: it is the parser web-push sends with.
  return legacyParse(endpoint).hostname === new URL(endpoint).hostname
}

export function createWebPushSender(config: WebPushConfig, lib: typeof webpush = webpush): PushSender {
  const vapidDetails = { subject: config.subject, publicKey: config.publicKey, privateKey: config.privateKey }
  return {
    async send(target, payload, options) {
      // A row the check would refuse today is never requested: it is dropped.
      if (!isSendableEndpoint(target.endpoint)) return { kind: 'gone' }
      const subscription: PushSubscription = {
        endpoint: target.endpoint,
        keys: { p256dh: target.p256dh, auth: target.auth },
      }
      try {
        const result = await lib.sendNotification(subscription, payload, {
          TTL: options.ttlSeconds,
          urgency: options.urgency,
          topic: options.topic,
          vapidDetails,
          timeout: SEND_TIMEOUT_MS,
        })
        return outcomeForStatus(result.statusCode)
      } catch (error) {
        // The library throws for every non-2xx, with the status on the error.
        // No status is a network failure or a timeout: worth trying again.
        const status = statusOf(error)
        return status === null ? { kind: 'transient', status: null } : outcomeForStatus(status)
      }
    },
  }
}
