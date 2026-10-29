/**
 * PostHog web analytics for the public site: which script a visitor's browser
 * is handed, decided from the environment of the running container.
 *
 * Why a script that is served and not code in the layout. Every page is
 * prerendered at build time, and the Docker image builds with no env files, so
 * a host or token read in `BaseLayout.astro`'s frontmatter would be baked in as
 * `undefined` and analytics would stay off on every deployed stack while
 * working in `astro dev`. The same trap the app tier avoids by reading
 * `NEXT_PUBLIC_POSTHOG_*` per request (`apps/workspace/bff/analytics`), and
 * the same remedy `src/pages/sign-in.ts` uses for `PUBLIC_APP_URL`: the page
 * carries one relative `<script src="/web-analytics.js">`, and that SSR route
 * answers from `process.env` at request time. One image serves every stack.
 *
 * Off by default. Without both `PUBLIC_POSTHOG_HOST` and
 * `PUBLIC_POSTHOG_PROJECT_TOKEN` (or with a host that is not an http(s) URL)
 * the route answers an empty script: no third-party request, nothing stored.
 *
 * What it asks PostHog for, and why (each line is a claim the privacy policy in
 * `src/i18n/pages/privacy.ts` makes, so change them together):
 *
 * - Consent, the SDK's way (owner decision D24): `cookieless_mode: 'on_reject'`
 *   with `opt_out_capturing_by_default: true`. Until the visitor chooses, and
 *   after "Decline", PostHog runs cookieless: nothing is written to the device
 *   and ingestion counts visitors from a hash of IP address, user agent and a
 *   daily salt. The PostHog project must have cookieless server hash mode set
 *   to "stateful", or ingestion discards those events (README, "Analytics").
 *   "Accept" calls `posthog.opt_in_capturing()`: the SDK then keeps its
 *   `ph_<token>_posthog` cookie and localStorage entry, so a visitor is the
 *   same visitor across visits, and session replay may run. Both choices are
 *   remembered by the SDK itself (`__ph_opt_in_out_<token>`); the consent note
 *   (`src/components/ConsentNote.astro`) only asks and calls the SDK.
 * - Session replay masks every input and every text (`session_recording`), and
 *   the project records only on its triggers (errors, rage clicks). It records no
 *   console logs (`enable_recording_console_log: false`), although the project,
 *   shared with the app, turns that on: the init option beats the project setting.
 * - `person_profiles: 'identified_only'`: a visitor never becomes a person
 *   profile. The landing site identifies nobody.
 * - Pageviews, page leaves, web vitals, autocaptured clicks and heatmaps: on
 *   in both modes. Surveys: off.
 * - `respect_dnt`: a browser that sends Do Not Track is not measured.
 *
 * Everything else is the SDK's own: autocapture records clicks and form
 * submits, and markup adds properties to them with `data-ph-capture-attribute-*`
 * (a CTA's area, the language switch). Campaign parameters and the referrer
 * ride on every pageview, and `$pageleave` carries the scroll depth. Two events
 * are the site's: `form_submitted` (the mailto hand-off, `src/components/MailForm.astro`)
 * and `video_played` (`src/components/Video.astro`). README, "Analytics".
 * The loader dispatches `ANALYTICS_READY_EVENT` on `window` after `init`, so the
 * consent note knows the SDK is there to ask.
 *
 * Run as plain Node (`node --test runtime/*.test.mjs`), so the decision is a
 * pure function with a spec instead of something a deploy discovers.
 */

/** The posthog-js config defaults snapshot the app tier pins as well. */
export const POSTHOG_DEFAULTS = '2026-01-30'

/** Dispatched on `window` after `posthog.init`; the consent note listens for it. */
export const ANALYTICS_READY_EVENT = 'analytics:ready'

/**
 * @typedef {object} WebAnalyticsConfig
 * @property {string} host Ingestion host without a trailing slash, e.g. `https://eu.i.posthog.com`.
 * @property {string} token Public project token (`phc_…`).
 */

/**
 * The analytics configuration for this container, or `null` when it is off.
 *
 * @param {Record<string, string | undefined>} env
 * @returns {WebAnalyticsConfig | null}
 */
export function webAnalyticsConfig(env) {
  const rawHost = (env.PUBLIC_POSTHOG_HOST ?? '').trim()
  const token = (env.PUBLIC_POSTHOG_PROJECT_TOKEN ?? '').trim()
  if (rawHost === '' || token === '') return null
  let url
  try {
    url = new URL(rawHost)
  } catch {
    return null
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null
  return { host: url.origin + url.pathname.replace(/\/+$/, ''), token }
}

/**
 * The `posthog.init` options for the landing site. Exported so the spec holds
 * the privacy posture to the policy text.
 *
 * @param {WebAnalyticsConfig} config
 */
export function webAnalyticsInitOptions(config) {
  return {
    api_host: config.host,
    defaults: POSTHOG_DEFAULTS,
    cookieless_mode: 'on_reject',
    opt_out_capturing_by_default: true,
    person_profiles: 'identified_only',
    capture_pageview: 'history_change',
    capture_pageleave: true,
    capture_performance: { web_vitals: true },
    enable_heatmaps: true,
    session_recording: { maskAllInputs: true, maskTextSelector: '*' },
    enable_recording_console_log: false,
    disable_surveys: true,
    respect_dnt: true,
  }
}

/**
 * The origins the browser talks to when analytics is on: the ingestion host
 * and the host the SDK bundle comes from. The Content-Security-Policy
 * (`security-headers.mjs`) allows exactly these.
 *
 * @param {WebAnalyticsConfig | null} config
 * @returns {{ connect: string[], script: string[] }}
 */
export function analyticsOrigins(config) {
  if (config === null) return { connect: [], script: [] }
  const ingest = new URL(config.host).origin
  const assets = new URL(sdkUrl(config.host)).origin
  return { connect: [...new Set([ingest, assets])], script: [assets] }
}

/**
 * PostHog serves its SDK bundle from an assets host next to the ingestion host
 * on Cloud (`eu.i.posthog.com` → `eu-assets.i.posthog.com`); any other host
 * (a first-party proxy) serves it itself. This is the rule of PostHog's own
 * snippet.
 *
 * @param {string} host
 */
export function sdkUrl(host) {
  return host.replace('.i.posthog.com', '-assets.i.posthog.com') + '/static/array.js'
}

/**
 * The body of `/web-analytics.js`: a loader that fetches PostHog's SDK and
 * initialises it, or a comment when analytics is off.
 *
 * `array.js` creates `window.posthog` itself when no snippet stub is present
 * (verified against posthog-js 1.428), so the loader needs no stub and no
 * queue: it loads the bundle, calls `init` and tells the page.
 *
 * @param {WebAnalyticsConfig | null} config
 */
export function webAnalyticsScript(config) {
  if (config === null) return '/* web analytics: off */\n'
  const options = JSON.stringify(webAnalyticsInitOptions(config))
  return `(function () {
  var s = document.createElement('script');
  s.async = true;
  s.crossOrigin = 'anonymous';
  s.src = ${JSON.stringify(sdkUrl(config.host))};
  s.onload = function () {
    if (window.posthog && typeof window.posthog.init === 'function') {
      window.posthog.init(${JSON.stringify(config.token)}, ${options});
      window.dispatchEvent(new Event(${JSON.stringify(ANALYTICS_READY_EVENT)}));
    }
  };
  document.head.appendChild(s);
})();
`
}
