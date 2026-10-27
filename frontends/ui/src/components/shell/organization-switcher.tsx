'use client'

/**
 * WorkOS's own organization switcher, for a person who works in more than one
 * office. The widget lists the organizations the person belongs to (from a
 * scope-less widget token: no permission is needed to see your own
 * memberships); picking one asks AuthKit to move the session there, which is a
 * refresh into that organization, or a sign-in when it requires SSO or MFA.
 *
 * Every page under `/app` belongs to the organization it was rendered for, so
 * after the switch the browser goes to the new office's projects with a full
 * load, rather than refreshing a page that may name a project the new office
 * does not have.
 *
 * Rendered only where the shell says the person has several organizations
 * (`belongsToSeveralOrganizations`), and only in the org header: inside a
 * project the switch would strand the page.
 */

import type { JSX } from 'react'
import { useCallback, useMemo } from 'react'
import { useAuth } from '@workos-inc/authkit-nextjs/components'
import { OrganizationSwitcher, WorkOsWidgets } from '@workos-inc/widgets'
import '@radix-ui/themes/styles.css'

import { makeWidgetTokenFetcher } from '@/lib/workos/widget-token'
import { useResolvedAppearance, widgetTheme } from '@/lib/workos/use-widget-appearance'

const AFTER_SWITCH = '/app/projects'

/**
 * An organization that requires SSO or MFA: AuthKit's server action answers
 * with `redirect()` to WorkOS, and Next is already navigating there when it
 * rejects the action's promise with its redirect error (`NEXT_REDIRECT…`
 * digest, what Next's own `isRedirectError` reads). Nothing failed.
 */
function isNavigatingAway(error: unknown): boolean {
  if (typeof error !== 'object' || error === null || !('digest' in error)) return false
  return String(error.digest).startsWith('NEXT_REDIRECT')
}

export function HeaderOrganizationSwitcher(): JSX.Element {
  const { switchToOrganization } = useAuth()
  const appearance = useResolvedAppearance()
  const authToken = useMemo(() => makeWidgetTokenFetcher(), [])

  const switchTo = useCallback(
    async ({ organizationId }: { organizationId: string }) => {
      try {
        await switchToOrganization(organizationId)
      } catch (error) {
        if (isNavigatingAway(error)) return
        throw error
      }
      window.location.assign(AFTER_SWITCH)
    },
    [switchToOrganization],
  )

  return (
    <WorkOsWidgets theme={widgetTheme(appearance)}>
      <OrganizationSwitcher authToken={authToken} switchToOrganization={switchTo} variant="ghost" truncateBehavior="middle" />
    </WorkOsWidgets>
  )
}

export default HeaderOrganizationSwitcher
