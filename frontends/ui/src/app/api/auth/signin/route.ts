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
 * Anonymous by design: like /api/auth/callback, it runs BEFORE a session
 * exists — creating one is its whole job — so no session-based posture can
 * apply. AuthKit's middlewareAuth lets it through via
 * proxy.ts unauthenticatedPaths.
 */
const signIn = async (request: NextRequest): Promise<Response> => {
  const returnTo = safeReturnPathname(new URL(request.url).searchParams.get('returnPathname'))
  const url = await getSignInUrl(returnTo ? { returnTo } : {})
  return NextResponse.redirect(url)
}

export const GET = tenantSlotRoute(signIn)
