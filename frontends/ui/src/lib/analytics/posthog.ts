/**
 * PostHog browser client — analytics, replay, surveys and Support, privacy-first.
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
 * `identifyPosthog` / `resetPosthog` / `sendPosthogSupportMessage` directly and
 * never touch `posthog-js` or branch on configuration themselves.
 *
 * PRIVACY POSTURE (the reasons are the contract; change one and re-read all):
 *
 * - **Storage: `persistence: 'memory'`.** The legal text (`lib/legal/content`,
 *   section "Cookies") promises "only strictly necessary cookies" and no banner.
 *   PostHog's default (`localStorage+cookie`) breaks that on the first page.
 *   The alternatives, checked against PostHog's docs (tutorials/cookieless-tracking,
 *   libraries/js/persistence): `cookieless_mode: 'always'` stores nothing too,
 *   but it DISABLES session replay and surveys and discourages `identify()`;
 *   `localStorage`/`sessionStorage` are still storage on the terminal that
 *   §165 TKG covers. `memory` keeps nothing in the browser, and still supports
 *   identify, replay (one session per page load, not per visit) and surveys.
 *   What it costs: the anonymous id and session id are new on every full page
 *   load. That is acceptable because every signed-in load identifies with the
 *   WorkOS user id before anything else is captured, so the person is stable;
 *   only the replay/session boundary moves from "visit" to "page load". Known
 *   exception: posthog-js's survey runtime writes its own `seenSurvey_*` /
 *   `lastSeenSurveyDate` keys to localStorage when a survey is SHOWN, outside
 *   `persistence`. Nothing is written until a survey is displayed.
 * - **Identity: the WorkOS user id only.** `identify(id)` carries no email, no
 *   name, nothing derivable. `person_profiles: 'identified_only'` means a
 *   signed-out visitor never creates a person profile.
 * - **Tenant context travels as properties, not groups.** `organization_id` is
 *   registered as a super property on identify and dropped by `reset()`. PostHog
 *   group analytics is a paid add-on, billed on every identified event once
 *   subscribed, so `posthog.group()` is deliberately not used.
 * - **Autocapture sees structure, not words.** `mask_all_text` and
 *   `mask_all_element_attributes` keep element text and attributes (hrefs can
 *   carry signed URLs) out of click events; product questions are answered by
 *   the closed `PostHogEvent` union below.
 * - **Replay is off unless configured, then sampled and masked.** See
 *   `buildSessionRecordingOptions`.
 */

import posthog, {
  type CapturedNetworkRequest,
  type PostHogConfig as PostHogSdkConfig,
  type SessionRecordingOptions,
} from 'posthog-js'

import {
  DISABLED_POSTHOG_CONFIG,
  REPLAY_BLOCK_CLASS,
  postHogConfigFromEnv,
  type PostHogConfig,
} from './posthog-config'

export { DISABLED_POSTHOG_CONFIG, postHogConfigFromEnv, type PostHogConfig }

type PostHogProperties = Record<string, string | number | boolean | null | undefined>

/**
 * Product events the UI emits. A closed union so a typo'd event name fails
 * the build instead of silently creating a second, almost-identical event in
 * PostHog. Add the name here when a call site starts emitting a new one.
 *
 * `report_exported` is the trigger of the CSAT survey in PostHog (a person took a
 * generated document out of the app); its properties are `kind` and `format`.
 *
 * Properties are non-identifying by rule: enums, counts, booleans, ids of our
 * own rows. Never free text, never file names, never an address.
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
  | 'answer_feedback_submitted'
  | 'product_feedback_submitted'
  | 'document_uploaded'
  | 'chat_message_sent'
  | 'report_exported'

let initialized = false

/**
 * The URL with its query string and fragment removed. Signed image URLs carry
 * their HMAC in the query (`lib/images/signed-image-url.ts`), so a recorded
 * request must never keep it.
 */
export const stripUrlQuery = (url: string): string => {
  const cut = url.search(/[?#]/)
  return cut === -1 ? url : url.slice(0, cut)
}

/**
 * Replay's network entry for one request: the URL without query or fragment,
 * and no headers or bodies. `recordHeaders`/`recordBody` are off already; this
 * is the second lock for the case a remote project setting turns them on.
 */
export const maskReplayNetworkRequest = (request: CapturedNetworkRequest): CapturedNetworkRequest => ({
  ...request,
  name: stripUrlQuery(request.name),
  requestHeaders: undefined,
  requestBody: undefined,
  responseHeaders: undefined,
  responseBody: undefined,
})

/**
 * What the recorder may see.
 *
 * - `maskAllInputs` + `maskTextSelector: '*'`: every typed value and every text
 *   node is replaced by asterisks of its length. A replay shows layout, clicks,
 *   scrolling and rage, never a question, an answer or a document line. There
 *   is no unmask allow-list: posthog-js 1.428 has no unmask selector, and
 *   inventing one through `maskTextFn` would make the chrome/content boundary a
 *   regex nobody reviews.
 * - `blockSelector`: media is not text, so `maskTextSelector` leaves an `<img>`'s
 *   `src` in the recording. Images, video, canvas and frames are blocked
 *   outright, and the PDF and IFC viewers carry `ph-no-capture` themselves.
 * - `captureCanvas.recordCanvas: false`: the IFC model is a WebGL canvas; the
 *   local setting beats the project's remote one.
 * - Network: headers and bodies off, query strings stripped
 *   (`maskReplayNetworkRequest`), console log capture off.
 * - `sampleRate` is the free-tier brake (5K recordings a month).
 */
export const buildSessionRecordingOptions = (sampleRate: number): SessionRecordingOptions => ({
  maskAllInputs: true,
  maskTextSelector: '*',
  blockClass: REPLAY_BLOCK_CLASS,
  blockSelector: 'img, video, canvas, iframe, object, embed',
  captureCanvas: { recordCanvas: false },
  recordHeaders: false,
  recordBody: false,
  maskCapturedNetworkRequestFn: maskReplayNetworkRequest,
  sampleRate,
})

/**
 * The `posthog.init` options for one deployment's config. Pure, so the privacy
 * posture in the header is asserted by a spec rather than remembered.
 */
export const buildPosthogInitOptions = (config: PostHogConfig): Partial<PostHogSdkConfig> => ({
  api_host: config.host,
  defaults: '2026-01-30',
  persistence: 'memory',
  person_profiles: 'identified_only',
  mask_all_text: true,
  mask_all_element_attributes: true,
  capture_exceptions: {
    capture_unhandled_errors: true,
    capture_unhandled_rejections: true,
    capture_console_errors: false,
  },
  disable_session_recording: !config.sessionReplay,
  enable_recording_console_log: false,
  session_recording: buildSessionRecordingOptions(config.replaySampleRate),
  debug: process.env.NODE_ENV === 'development',
})

/**
 * Initialize the browser PostHog session. Idempotent — safe to call on every
 * render. No-op without both values (analytics disabled) and outside the
 * browser (server-side import safety).
 */
export const initPosthogClient = (config: PostHogConfig): void => {
  if (initialized || typeof window === 'undefined') return
  if (!config.host || !config.projectToken) return
  posthog.init(config.projectToken, buildPosthogInitOptions(config))
  initialized = true
}

/** Whether the client was initialized — i.e. whether events are being sent. */
export const isPosthogEnabled = (): boolean => initialized

/** Capture a product event. No-op when analytics is disabled. */
export const capturePosthog = (event: PostHogEvent, properties?: PostHogProperties): void => {
  if (!initialized) return
  posthog.capture(event, properties)
}

/**
 * Associate the session with the authenticated user. The WorkOS user id is the
 * only thing sent: no email, no name, so the profile is a pseudonym that only
 * someone holding WorkOS access can resolve. No-op when disabled.
 */
export const identifyPosthog = (distinctId: string): void => {
  if (!initialized) return
  posthog.identify(distinctId)
}

/**
 * Stamp every following event with the WorkOS organization, or drop the stamp
 * (`null`/`undefined`). A super property rather than a group: see the header.
 * `reset()` clears it with the rest of the identity. No-op when disabled.
 */
export const setPosthogOrganization = (organizationId: string | null | undefined): void => {
  if (!initialized) return
  if (organizationId) posthog.register({ organization_id: organizationId })
  else posthog.unregister('organization_id')
}

/** Clear the session (sign-out, account switch). No-op when disabled. */
export const resetPosthog = (): void => {
  if (!initialized) return
  posthog.reset()
}

/**
 * Open a PostHog Support ticket with `message`, always a NEW ticket (each
 * feedback report is its own thread). Resolves `true` only when PostHog took
 * it; `false` when analytics is off, Support is not enabled for the project or
 * not loaded yet, or the request failed. Never throws, because it runs beside
 * the first-party submit and must not be able to fail it.
 *
 * No traits are passed. posthog-js falls back to the person's `email`/`name`
 * properties when none are given; we never set them, so the ticket carries the
 * distinct id and the replay link, nothing else.
 */
export const sendPosthogSupportMessage = async (message: string): Promise<boolean> => {
  if (!initialized) return false
  try {
    const support = posthog.conversations
    if (!support?.isAvailable()) return false
    const response = await support.sendMessage(message, undefined, true)
    return response !== null
  } catch {
    return false
  }
}
