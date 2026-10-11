import type { APIRoute } from 'astro'
import { webAnalyticsConfig, webAnalyticsScript } from '../../runtime/web-analytics.mjs'

/**
 * The page's one analytics script, answered from the container's environment.
 *
 * The pages are prerendered and the image is built with no env files, so the
 * PostHog host and token cannot be read where the HTML is made; they are read
 * here, per request, from `PUBLIC_POSTHOG_HOST` / `PUBLIC_POSTHOG_PROJECT_TOKEN`
 * (Pulumi: `grid-oib:posthogHost` / `posthogProjectToken`). Unset, the body is
 * a comment and the visitor's browser contacts nobody. The decision and the
 * init options live in `runtime/web-analytics.mjs`, where a spec holds them to
 * the privacy policy. Same shape as `sign-in.ts` for `PUBLIC_APP_URL`.
 */
export const prerender = false

export const GET: APIRoute = () =>
  new Response(webAnalyticsScript(webAnalyticsConfig(process.env)), {
    headers: {
      'Content-Type': 'text/javascript; charset=utf-8',
      // Configuration, not content: short enough that switching a stack on or
      // off reaches a returning visitor within minutes, long enough that the
      // script is not fetched on every page view.
      'Cache-Control': 'public, max-age=300',
    },
  })
