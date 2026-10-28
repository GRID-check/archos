/**
 * PostHog web analytics for the public site: which script a visitor's browser
 * is handed, decided from the environment of the running container.
 *
 * Why a script that is served and not code in the layout. Every page is
 * prerendered at build time, and the Docker image builds with no env files, so
 * a host or token read in `BaseLayout.astro`'s frontmatter would be baked in as
 * `undefined` and analytics would stay off on every deployed stack while
 * working in `astro dev`. The same trap the app tier avoids by reading
 * `NEXT_PUBLIC_POSTHOG_*` per request (`frontends/ui/src/lib/analytics`), and
 * the same remedy `src/pages/sign-in.ts` uses for `PUBLIC_APP_URL`: the page
 * carries one relative `<script src="/web-analytics.js">`, and that SSR route
 * answers from `process.env` at request time. One image serves every stack.
 *
 * Off by default. Without both `PUBLIC_POSTHOG_HOST` and
 * `PUBLIC_POSTHOG_PROJECT_TOKEN` (or with a host that is not an http(s) URL)
 * the route answers an empty script: no third-party request, nothing stored.
 *
 * What it asks PostHog for, and why (each line is a claim the privacy policy in
 * `src/i18n/ui.ts` makes, so change them together):
 *
 * - `person_profiles: 'identified_only'`: a visitor never becomes a person
 *   profile. The landing site identifies nobody; the app does, after sign-in.
 * - `cross_subdomain_cookie: true`: the `ph_<token>_posthog` cookie is set for
 *   the registrable domain, so the anonymous id a visitor got here is the one
 *   the app (same project, same token) sees after the WorkOS redirect. That is
 *   the landing-to-signup stitching.
 * - Pageviews, page leaves, web vitals and heatmaps: on. Session replay and
 *   surveys: off, the landing site records no screens and shows no survey.
 * - `respect_dnt`: a browser that sends Do Not Track is not measured.
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
    person_profiles: 'identified_only',
    persistence: 'localStorage+cookie',
    cross_subdomain_cookie: true,
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
