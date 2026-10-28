'use client'

import { useEffect } from 'react'
import Link from 'next/link'

import { Button } from '@/components/ui/button'
import { StatusScreen } from '@/components/brand/status-screen'
import { useTranslations } from '@/i18n'
import { errorsCopy } from '@/i18n/namespaces/errors'
import { capturePosthogException } from '@/lib/analytics/posthog'

/**
 * Route-level error boundary. Catches thrown errors (including the plain
 * Error('Not found') that requireProjectAccess raises on permission denial)
 * and renders GRID's own chrome instead of Next's default crash page.
 */
export default function RouteError({
  error,
  reset,
}: {
  error: Error & { digest?: string }
  reset: () => void
}) {
  const t = useTranslations(errorsCopy)

  // Classified by message, because this is a client boundary: a server-thrown
  // `ApiError` crosses the RSC boundary as a plain `Error`, so the typed check
  // the server uses (`isAuthzRefusal`) cannot see it here. Never a bare
  // substring match: a naive /access/i also matches unrelated crashes such as
  // "Cannot access 'x' before initialization", which would misroute a real bug
  // to the access-denied screen. `isAccessDenial` matches only the messages the
  // authz errors carry, so an unknown error falls through to the generic
  // screen (fail-safe).
  const isAccess = isAccessDenial(error)

  useEffect(() => {
    console.error('[route error]', error)
    // A boundary swallows the error before `window.onerror` sees it, so PostHog's
    // autocapture never does; report it here (ADR-0100). Not a denial (an
    // expected outcome, not a defect), and not one with a `digest`: that error
    // was thrown on the server, where `onRequestError` already reported it with
    // its stack, and the copy here is the redacted "error occurred in the Server
    // Components render" that would open a second, useless issue.
    if (isAccess || error.digest) return
    capturePosthogException(error, { source: 'route-error-boundary' })
  }, [error, isAccess])

  return (
    <StatusScreen
      code={isAccess ? t('access.code') : t('appError.code')}
      title={isAccess ? t('access.title') : t('appError.title')}
      description={isAccess ? t('access.description') : t('appError.description')}
      actions={
        <>
          {/* Always offered, even on the access screen: an unknown error must
              never be hidden behind a dead-end, and even a genuine access
              denial can be transient (a role grant that just landed, a stale
              cache). */}
          <Button variant="outline" onClick={reset}>
            {t('appError.action')}
          </Button>
          {isAccess ? (
            // Home re-resolves the session client-side and never rethrows:
            // an authenticated visitor bounces straight to /app/projects, a
            // signed-out one lands on the sign-in screen. Routing back to
            // the project/org page that just failed here would re-run the
            // same guard and re-throw the same error — a dead-end loop.
            <Button asChild>
              <Link href="/">{t('access.action')}</Link>
            </Button>
          ) : (
            <Button asChild>
              <Link href="/app/projects">{t('appError.backAction')}</Link>
            </Button>
          )}
        </>
      }
    />
  )
}

/**
 * The messages the authz errors carry: `NotFoundError` ("Not found",
 * `requireProjectAccess`), `ForbiddenError` and `NoOrganizationError`
 * ("Forbidden…"), `UnauthorizedError` and `SessionRequiredError`
 * ("Unauthorized…").
 */
function isAccessDenial(error: Error): boolean {
  const message = error.message.toLowerCase()
  return (
    message === 'not found' ||
    message.startsWith('not found:') ||
    message.includes('unauthorized') ||
    message.includes('forbidden')
  )
}
