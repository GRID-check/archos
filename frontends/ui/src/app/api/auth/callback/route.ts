import { CallbackError, handleAuth } from '@workos-inc/authkit-nextjs'
import { type NextRequest, NextResponse } from 'next/server'
import { captureServer } from '@/lib/analytics/posthog-server'
import { tenantSlotRoute } from '@/lib/db/tenant-context'

/**
 * Post-login redirect base.
 *
 * The frontend runs behind a proxy (Coolify/Traefik) with Next.js on an
 * internal address. Without a baseURL, authkit builds the post-callback
 * redirect from the request origin, which leaks the internal host
 * (e.g. https://0.0.0.0:3001/app/projects) instead of the public domain.
 *
 * The configured redirect URI is already the public callback URL, so its
 * origin is the correct public base. authkit overrides the pathname with
 * returnPathname, so only the origin of baseURL is used. Unset (auth disabled)
 * → undefined → authkit falls back to the request URL.
 *
 * Prefer the plain WORKOS_REDIRECT_URI (a normal server env var, read at
 * runtime) over NEXT_PUBLIC_WORKOS_REDIRECT_URI, which Next can inline at build
 * time and would be empty when the value is only supplied at deploy time.
 */
const redirectUri = process.env.WORKOS_REDIRECT_URI ?? process.env.NEXT_PUBLIC_WORKOS_REDIRECT_URI
const baseURL = redirectUri ? new URL(redirectUri).origin : undefined

/**
 * An account WorkOS created this recently is a first sign-in. WorkOS creates
 * the user at sign-up and sends them straight to this callback, so a minute or
 * two separates the two; the window is generous for a slow email-verification
 * step, and a returning user's account is days old at least.
 */
const NEW_USER_WINDOW_MS = 10 * 60_000

/**
 * `user_signed_in` for PostHog (ADR-0100), from the server because this is the
 * one place a sign-in is certain: the browser lands on the app after the
 * redirect with nothing that says a login happened. `authenticationMethod` is
 * WorkOS's own enum (`SSO`, `Password`, `GoogleOAuth`, …), no identity.
 * Fire-and-forget: `captureServer` queues and never throws, so the redirect is
 * exactly as fast and as certain as before.
 */
type HandleAuthOptions = NonNullable<Parameters<typeof handleAuth>[0]>
type SignInData = Parameters<NonNullable<HandleAuthOptions['onSuccess']>>[0]

const announceSignIn = ({ user, organizationId, authenticationMethod }: SignInData): void => {
  const createdAt = Date.parse(user.createdAt)
  captureServer({
    event: 'user_signed_in',
    distinctId: user.id,
    organizationId: organizationId ?? null,
    properties: {
      method: authenticationMethod,
      is_new_user: Number.isNaN(createdAt) ? undefined : Date.now() - createdAt < NEW_USER_WINDOW_MS,
    },
  })
}

/**
 * A sign-in that arrives without its flow cannot be completed by retrying the
 * same callback URL: AuthKit has already deleted that flow's PKCE cookie, so a
 * reload reproduces the failure. The flow is lost when the browser dropped the
 * ten-minute verifier cookie, its window closed, or two tabs collided in one
 * cookie jar — `missing_pkce_cookie` and `oauth_state_mismatch` respectively.
 *
 * Send those to our own page, which says so and offers Try Again, instead of
 * AuthKit's generic 500. Everything else keeps the generic answer: an
 * `invalid_grant` from WorkOS is not something the person can act on
 * differently.
 */
const LOST_FLOW_CODES = new Set<string>(['missing_pkce_cookie', 'oauth_state_mismatch'])

function reportSignInFailure({ error, request }: { error?: unknown; request: NextRequest }): Response {
  const code = error instanceof CallbackError && LOST_FLOW_CODES.has(error.code) ? 'SessionExpired' : 'Default'
  return NextResponse.redirect(new URL(`/auth/error?error=${code}`, baseURL ?? request.url))
}

const authkitCallback = handleAuth({
  returnPathname: '/app/projects',
  baseURL,
  onSuccess: announceSignIn,
  onError: reportSignInFailure,
})

/**
 * A request that carries neither `code` nor `state` is not a returning
 * sign-in: it is a crawler or a bookmarked callback URL (#724 was
 * meta-externalagent). AuthKit logs every such request with `console.error`
 * before any `onError` could lower it, which files an issue, and answers 500.
 * It is sent to sign in instead and noted at debug. A request with `state` goes
 * to AuthKit as before, because AuthKit also clears that flow's PKCE cookie.
 */
async function callback(request: NextRequest): Promise<Response> {
  const { searchParams } = new URL(request.url)
  if (!searchParams.has('code') && !searchParams.has('state')) {
    console.debug('[auth] callback without code or state; redirecting to sign-in', {
      userAgent: request.headers.get('user-agent') ?? undefined,
    })
    return NextResponse.redirect(new URL('/api/auth/signin', baseURL ?? request.url))
  }
  return authkitCallback(request)
}

// Wrapped like every other route: this one runs BEFORE a session exists, so
// inheriting a tenant from the previous request on this socket would be
// especially wrong (ADR-0041).
export const GET = tenantSlotRoute(callback)
