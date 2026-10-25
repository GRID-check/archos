import { getSignInUrl } from '@workos-inc/authkit-nextjs'
import { cookies } from 'next/headers'
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
 * Anonymous by design: like /api/auth/callback, it runs BEFORE a session
 * exists — creating one is its whole job — so no session-based posture can
 * apply. AuthKit's middlewareAuth lets it through via
 * proxy.ts unauthenticatedPaths.
 */

/**
 * AuthKit's middleware keeps at most five verifier cookies and expires the rest
 * (`MAX_PKCE_COOKIES` in its `pkce.ts`), because a pile of them risks HTTP 431.
 * That budget lives in the middleware path only; `setPKCECookie` just writes.
 * The proxy now sends every unauthenticated client navigation here, so a browser
 * that keeps bouncing would add one cookie per attempt for ten minutes and the
 * loop would end at a 431 instead of a login page.
 *
 * Mirror the budget. A flow live in another tab is given up only once the limit
 * is already reached, which is the trade AuthKit makes at the same point.
 */
const VERIFIER_COOKIE_PREFIX = 'wos-auth-verifier'
const MAX_VERIFIER_COOKIES = 5

async function expireVerifierCookies(): Promise<void> {
  const jar = await cookies()
  const verifiers = jar
    .getAll()
    .filter(({ name }) => name === VERIFIER_COOKIE_PREFIX || name.startsWith(`${VERIFIER_COOKIE_PREFIX}-`))

  if (verifiers.length < MAX_VERIFIER_COOKIES) return
  for (const { name } of verifiers) jar.delete(name)
}

const signIn = async (request: NextRequest): Promise<Response> => {
  await expireVerifierCookies()

  const returnTo = safeReturnPathname(new URL(request.url).searchParams.get('returnPathname'))
  const url = await getSignInUrl(returnTo ? { returnTo } : {})
  return NextResponse.redirect(url)
}

export const GET = tenantSlotRoute(signIn)
