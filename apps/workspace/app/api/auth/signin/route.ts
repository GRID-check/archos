import { getSignInUrl } from '@workos-inc/authkit-nextjs'
import { type NextRequest, NextResponse } from 'next/server'
import { safeReturnPathname } from '@/lib/auth/return-pathname'
import { tenantSlotRoute } from '@/lib/db/tenant-context'

/**
 * Sign-in entry point.
 *
 * `getSignInUrl()` seals the PKCE state and writes it as a cookie via
 * `cookies().set()` — which Next.js allows ONLY in a Server Function or a
 * Route Handler, never during Server Component rendering. The root page (`/`,
 * the landing site's "Anmelden" target) used to call it directly inside its
 * render: every anonymous visit to `/?sign-in` threw mid-render and surfaced
 * the app-wide error boundary instead of WorkOS. The page now redirects here,
 * and this handler — a Route Handler, where cookie mutation is legal — issues
 * the authorization redirect with its PKCE cookie attached.
 *
 * The proxy sends a navigation it could not authenticate here too, with
 * `returnPathname`, because AuthKit's own middleware redirect mints no verifier
 * cookie for a client-side navigation and that flow can never complete.
 *
 * `getSignInUrl` caps the verifier cookies it leaves behind at five, as the
 * middleware does (authkit-nextjs 4.6.2, #505), so a browser that keeps
 * bouncing through here cannot fill its cookie jar into an HTTP 431.
 *
 * Anonymous by design: like /api/auth/callback, it runs BEFORE a session
 * exists — creating one is its whole job — so no session-based posture can
 * apply. AuthKit's middlewareAuth lets it through via
 * proxy.ts unauthenticatedPaths.
 *
 * `loginHint` carries the e-mail a person typed on the website's login form, so
 * AuthKit opens with it filled in. Only a plausible address is passed on; anything
 * else is dropped rather than echoed into the authorization URL.
 */

const LOGIN_HINT = /^[^\s@]{1,64}@[^\s@]{1,255}$/

const loginHintFrom = (value: string | null): string | undefined =>
  value && LOGIN_HINT.test(value) ? value : undefined

const signIn = async (request: NextRequest): Promise<Response> => {
  const params = new URL(request.url).searchParams
  const returnTo = safeReturnPathname(params.get('returnPathname'))
  const loginHint = loginHintFrom(params.get('loginHint'))
  const url = await getSignInUrl({ ...(returnTo && { returnTo }), ...(loginHint && { loginHint }) })
  return NextResponse.redirect(url)
}

export const GET = tenantSlotRoute(signIn)
