/**
 * Web Push configuration: the VAPID key pair and the contact it is signed with
 * (ADR-0112).
 *
 * Read from the environment on every call, as the PostHog pair is, so a
 * deployment is pointed at new keys by restarting, not rebuilding. With no
 * usable configuration the feature is off: the public key route says so, the
 * settings section is not drawn and inbox writes enqueue nothing. An invalid
 * value is off too, and says why once, because a half-set pair that quietly
 * worked "somewhat" would be worse than a feature that is plainly absent.
 *
 * Unlike a secret read at boot, nothing here is cached: a bad value is cheap to
 * re-parse and the log line is deduplicated.
 */

import 'server-only'

export interface WebPushConfig {
  /** Uncompressed P-256 public key, URL-safe base64: what `applicationServerKey` takes. */
  publicKey: string
  privateKey: string
  /** `mailto:` or `https:` contact the push service may reach the operator on. */
  subject: string
}

const BASE64URL = /^[A-Za-z0-9_-]+$/

/** Bytes a URL-safe base64 string decodes to, or -1 when it is not one. */
function base64UrlLength(value: string): number {
  if (!BASE64URL.test(value)) return -1
  return Buffer.from(value, 'base64url').length
}

/** Why a configuration is unusable, or null when it is fine. */
export function webPushConfigProblem(env: Record<string, string | undefined>): string | null {
  const publicKey = env.WEB_PUSH_VAPID_PUBLIC_KEY?.trim()
  const privateKey = env.WEB_PUSH_VAPID_PRIVATE_KEY?.trim()
  const subject = env.WEB_PUSH_SUBJECT?.trim()
  if (!publicKey && !privateKey && !subject) return null
  if (!publicKey || !privateKey || !subject) {
    return 'WEB_PUSH_VAPID_PUBLIC_KEY, WEB_PUSH_VAPID_PRIVATE_KEY and WEB_PUSH_SUBJECT must be set together'
  }
  if (base64UrlLength(publicKey) !== 65) return 'WEB_PUSH_VAPID_PUBLIC_KEY is not a URL-safe base64 P-256 public key (65 bytes)'
  if (base64UrlLength(privateKey) !== 32) return 'WEB_PUSH_VAPID_PRIVATE_KEY is not a URL-safe base64 P-256 private key (32 bytes)'
  if (!/^(mailto:[^@\s]+@[^@\s]+|https:\/\/\S+)$/.test(subject)) {
    return 'WEB_PUSH_SUBJECT must be a mailto: address or an https: URL'
  }
  return null
}

let reported: string | null = null

/** The configuration, or null when Web Push is off in this deployment. */
export function webPushConfig(env: Record<string, string | undefined> = process.env): WebPushConfig | null {
  const problem = webPushConfigProblem(env)
  if (problem) {
    if (reported !== problem) {
      reported = problem
      console.warn(`[push] Web Push is off: ${problem}`)
    }
    return null
  }
  const publicKey = env.WEB_PUSH_VAPID_PUBLIC_KEY?.trim()
  const privateKey = env.WEB_PUSH_VAPID_PRIVATE_KEY?.trim()
  const subject = env.WEB_PUSH_SUBJECT?.trim()
  return publicKey && privateKey && subject ? { publicKey, privateKey, subject } : null
}
