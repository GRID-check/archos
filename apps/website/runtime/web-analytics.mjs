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
 * - `cookieless_mode: 'always'`: nothing is written to the visitor's device: no
 *   cookie, no localStorage, no sessionStorage. PostHog's ingestion counts
 *   visitors and sessions from a hash of IP address, user agent and a daily
 *   salt, so no consent is asked and no banner is shown. The PostHog project
 *   must have cookieless tracking switched on (Settings > Project > Web
 *   analytics), or ingestion discards every event (README, "Analytics").
 *   The price: a returning visitor is a new visitor each day, and the anonymous
 *   id does not travel to the app after sign-in (no landing-to-app stitching).
 * - `person_profiles: 'identified_only'`: a visitor never becomes a person
 *   profile. The landing site identifies nobody.
 * - Pageviews, page leaves, web vitals, autocaptured clicks and heatmaps: on.
 *   None of them stores anything in the browser. Session replay and surveys:
 *   off. Replay cannot run cookieless, and the landing site shows no survey.
 * - `respect_dnt`: a browser that sends Do Not Track is not measured.
 *
 * Everything else is the SDK's own: autocapture records clicks and form
 * submits, and markup adds properties to them with `data-ph-capture-attribute-*`
 * (a CTA's area, the language switch). Campaign parameters and the referrer
 * ride on every pageview, and `$pageleave` carries the scroll depth. Two events
 * are the site's: `form_submitted` (the mailto hand-off, `src/components/MailForm.astro`)
 * and `video_played` (`src/components/Video.astro`). README, "Analytics".
 *
 * Run as plain Node (`node --test runtime/*.test.mjs`), so the decision is a
 * pure function with a spec instead of something a deploy discovers.
 */

/** The posthog-js config defaults snapshot the app tier pins as well. */
export const POSTHOG_DEFAULTS = '2026-01-30'

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
    cookieless_mode: 'always',
    person_profiles: 'identified_only',
    capture_pageview: 'history_change',
    capture_pageleave: true,
    capture_performance: { web_vitals: true },
    enable_heatmaps: true,
    disable_session_recording: true,
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
 * queue: it loads the bundle and calls `init`.
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
    }
  };
  document.head.appendChild(s);
})();
`
}
