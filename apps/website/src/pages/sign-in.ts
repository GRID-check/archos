import type { APIRoute } from 'astro'
import identity from '../lib/identity'

/**
 * Sign-in hand-off to the app.
 *
 * The form on /login GETs HERE, and this endpoint 302s on to the app's
 * sign-in route, which opens WorkOS AuthKit. The target host is deployment
 * configuration and is resolved at RUNTIME so one image serves every stack.
 * Prerendered HTML cannot do that: a host baked into the static build is how
 * a landing page once sent visitors to the dev app. The Deployment injects
 * `PUBLIC_APP_URL` (`https://app.<baseDomain>` via Pulumi); unset falls back
 * to the brand domain, the same fail-safe as `LANDING_URL` on the app side.
 *
 * 302, not 301: the target comes from the environment, and a permanently
 * cached redirect would freeze whatever host answered first.
 */
export const prerender = false

export const GET: APIRoute = ({ url }) => {
  const appUrl = (process.env.PUBLIC_APP_URL ?? `https://app.${identity.domain}`).replace(/\/+$/, '')
  const email = url.searchParams.get('email')?.trim() ?? ''
  const hint = email.includes('@') ? `?loginHint=${encodeURIComponent(email)}` : ''
  return new Response(null, {
    status: 302,
    headers: {
      Location: `${appUrl}/api/auth/signin${hint}`,
      // The redirect target is configuration, not content - no layer between
      // here and the browser may remember a previous answer.
      'Cache-Control': 'no-store',
    },
  })
}
