/**
 * PostHog product analytics — fail-open client wrapper.
 *
 * Analytics is never a boot dependency: when the deployment configures no
 * PostHog host/token, every function below is a silent no-op and no event
 * leaves the browser. Configuration arrives at RUNTIME through `AppConfig`
 * (server reads the env per request, client receives it via context) rather
 * than through build-time `NEXT_PUBLIC_*` inlining — the Docker image builds
 * with no env files, so a build-time read would bake `undefined` into the
 * client bundle and silently disable analytics on every deployed environment
 * while working in `next dev`.
 *
 * This module is the single gate: call sites use `capturePosthog` /
 * `identifyPosthog` / `resetPosthog` directly and never touch `posthog-js`
 * or branch on configuration themselves.
 */

import posthog from 'posthog-js'

type PostHogProperties = Record<string, string | number | boolean | null | undefined>

/**
 * PostHog analytics configuration (fail-open). Empty host or token disables
 * the client. Produced server-side per request (layout `getAppConfig`) and
 * carried to the browser through `AppConfig`, so no rebuild is needed to
 * repoint a deployment.
 */
export interface PostHogConfig {
  /** Public PostHog host (e.g. `https://eu.i.posthog.com`). Empty = disabled. */
  host: string
  /** Public project token (`phc_…`). Empty = disabled. */
  projectToken: string
}

/**
 * Product events the UI emits. A closed union so a typo'd event name fails
 * the build instead of silently creating a second, almost-identical event in
 * PostHog. Add the name here when a call site starts emitting a new one.
 */
export type PostHogEvent =
  | 'organization_created'
  | 'product_tour_completed'
  | 'product_tour_skipped'
  | 'project_created'
  | 'project_member_access_changed'
  | 'job_created'
  | 'job_updated'
  | 'job_enabled_changed'
  | 'job_run_submitted'
  | 'job_deleted'
  | 'skill_created'
  | 'skill_updated'
  | 'skill_deleted'
  | 'skill_enabled_changed'
  | 'answer_retry_thorough'

let initialized = false

/** The disabled config: no host/token, every function below no-ops. */
export const DISABLED_POSTHOG_CONFIG: PostHogConfig = {
  host: '',
  projectToken: '',
}

/**
 * Initialize the browser PostHog session. Idempotent — safe to call on every
 * render. No-op without both values (analytics disabled) and outside the
 * browser (server-side import safety).
 */
export const initPosthogClient = (host: string, projectToken: string): void => {
  if (initialized || typeof window === 'undefined') return
  if (!host || !projectToken) return
  posthog.init(projectToken, {
    api_host: host,
    defaults: '2026-01-30',
    capture_exceptions: {
      capture_unhandled_errors: true,
      capture_unhandled_rejections: true,
      capture_console_errors: false,
    },
    debug: process.env.NODE_ENV === 'development',
  })
  initialized = true
}

/** Whether the client was initialized — i.e. whether events are being sent. */
export const isPosthogEnabled = (): boolean => initialized

/** Capture a product event. No-op when analytics is disabled. */
export const capturePosthog = (event: PostHogEvent, properties?: PostHogProperties): void => {
  if (!initialized) return
  posthog.capture(event, properties)
}

/** Associate the session with the authenticated user. No-op when disabled. */
export const identifyPosthog = (distinctId: string, traits?: PostHogProperties): void => {
  if (!initialized) return
  posthog.identify(distinctId, traits)
}

/** Clear the session (sign-out, account switch). No-op when disabled. */
export const resetPosthog = (): void => {
  if (!initialized) return
  posthog.reset()
}

const SESSION_ID_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * The id of the current PostHog browser session, or `null` when analytics is
 * disabled or the SDK has none yet. Sent with each chat turn so Langfuse's
 * PostHog export can put the turn's traces on this session's recording
 * (`trace.metadata.$posthog_session_id` -> `$session_id`). Read per turn, not
 * once: the id rotates after 30 idle minutes and on `reset()`.
 *
 * Only a UUID-shaped value is returned. The backend checks it again (UUIDv7)
 * because it is browser input; this side just keeps garbage off the wire.
 */
export const getPosthogSessionId = (): string | null => {
  if (!initialized) return null
  const id = posthog.get_session_id()
  return typeof id === 'string' && SESSION_ID_SHAPE.test(id) ? id : null
}
