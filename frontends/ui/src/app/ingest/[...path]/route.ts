/**
 * First-party PostHog ingestion: `/ingest/*` relays to the configured PostHog
 * host. The browser SDK points its `api_host` here (`lib/analytics/posthog.ts`)
 * so events, recordings, flag requests and SDK assets are same-origin requests.
 * The relay itself, and why it is a handler rather than a `rewrites` entry,
 * lives in `lib/analytics/posthog-proxy.ts`.
 *
 * This is the one route outside `app/api`, and it is still declared through the
 * factory: `publicApiRoute` with a `why`, as the route conventions require for
 * anything served without a session (`lib/api/handler.ts`). It is not reachable
 * by `authz-coverage.spec.ts` (that scans `app/api`), so `posthog-proxy.spec.ts`
 * pins the same two facts for this file.
 *
 * Authentication: none, and `src/proxy.ts` leaves the path out of its matcher.
 * The SDK posts from signed-out pages and from the moments between a session
 * expiring and the page noticing; an AuthKit redirect to WorkOS would answer a
 * beacon with a login page. It also keeps AuthKit from buffering replay bodies.
 *
 * The method list is the whole surface: the SDK only GETs assets and config and
 * POSTs events; `OPTIONS` is answered by Next from this list.
 */

import { publicApiRoute } from '@/lib/api/handler'
import { postHogConfigFromEnv } from '@/lib/analytics/posthog-config'
import { forwardToPosthog } from '@/lib/analytics/posthog-proxy'

// Always executes: every request is a live relay, never a cached page.
export const dynamic = 'force-dynamic'

// `process.env` is passed whole, not read key by key: Next inlines a literal
// `process.env.NEXT_PUBLIC_*` at build time, and this image is built with no
// environment (the same reason `app/layout.tsx` does it this way).
const relay = async ({ request }: { request: Request }): Promise<Response> =>
  forwardToPosthog(request, postHogConfigFromEnv(process.env))

const WHY =
  'Unauthenticated by necessity: the browser SDK posts analytics from signed-out pages and ' +
  'while a session is expiring, and an AuthKit redirect would answer a beacon with a login ' +
  'page. It holds no tenant data and reads none: it relays to ONE configured host (never one ' +
  'taken from the request), forwards an allow-list of headers (no cookies, no ' +
  'Authorization), and answers 404 when PostHog or the proxy is not configured.'

export const GET = publicApiRoute(relay, { why: WHY })
export const POST = publicApiRoute(relay, { why: WHY })
