'use client'

/**
 * „Switch organization" in the avatar menu, for a person who works in more than
 * one office. The list comes from the server (`switchableOrganizations`: the
 * person's active WorkOS memberships, by name); picking one asks AuthKit to move
 * the session there, which is a refresh into that organization, or a sign-in
 * when it requires SSO or MFA.
 *
 * Every page under `/app` belongs to the organization it was rendered for, so
 * after the switch the browser goes to the new office's projects with a full
 * load, rather than refreshing a page that may name a project the new office
 * does not have.
 *
 * A submenu of our own menu rather than WorkOS's `OrganizationSwitcher` widget:
 * the widget mounts a root Radix Theme, whose `min-height: 100dvh` and global
 * stylesheet came into the shell with it and stretched the header to the height
 * of the window, and its own dropdown cannot nest in this one.
 */

import type { JSX } from 'react'
import { useCallback, useState } from 'react'
import { ArrowLeftRight, Check } from 'lucide-react'
import { useAuth } from '@workos-inc/authkit-nextjs/components'

import {
  DropdownMenuItem,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
} from '@/components/ui/dropdown-menu'
import { useTranslations } from '@/i18n'
import { isFrameworkControlFlow } from '@/lib/analytics/control-flow-error'
import type { SwitchableOrganization } from '@/lib/organizations/switchable'

const AFTER_SWITCH = '/app/projects'

/**
 * An organization that requires SSO or MFA: AuthKit's server action answers
 * with `redirect()` to WorkOS, and Next is already navigating there when it
 * rejects the action's promise with its redirect error (`NEXT_REDIRECT…`
 * digest, what Next's own `isRedirectError` reads). Nothing failed.
 */
export function isNavigatingAway(error: unknown): boolean {
  return isFrameworkControlFlow(error)
}

export function OrganizationSwitcherMenu({
  organizations,
}: {
  organizations: readonly SwitchableOrganization[]
}): JSX.Element {
  const { switchToOrganization } = useAuth()
  const t = useTranslations('nav')
  const [pending, setPending] = useState<string | null>(null)
  const [failed, setFailed] = useState(false)

  const switchTo = useCallback(
    async (organizationId: string) => {
      setPending(organizationId)
      setFailed(false)
      try {
        await switchToOrganization(organizationId)
      } catch (error) {
        if (isNavigatingAway(error)) return
        setPending(null)
        setFailed(true)
        return
      }
      window.location.assign(AFTER_SWITCH)
    },
    [switchToOrganization],
  )

  return (
    <DropdownMenuSub>
      <DropdownMenuSubTrigger className="gap-2" data-testid="user-menu-switch-organization">
        <ArrowLeftRight className="size-4 text-muted-foreground" aria-hidden />
        {t('userMenu.switchOrganization')}
      </DropdownMenuSubTrigger>
      <DropdownMenuSubContent className="w-56">
        {organizations.map((organization) => (
          <DropdownMenuItem
            key={organization.id}
            disabled={organization.current || pending !== null}
            onSelect={(event) => {
              event.preventDefault()
              void switchTo(organization.id)
            }}
            className="gap-2"
          >
            <span className="flex-1 truncate">{organization.name}</span>
            {organization.current && <Check className="size-4" aria-label={t('userMenu.currentOrganization')} />}
            {pending === organization.id && (
              <span className="text-xs text-muted-foreground">{t('userMenu.switchingOrganization')}</span>
            )}
          </DropdownMenuItem>
        ))}
        {failed && (
          <p role="alert" className="px-2 py-1.5 text-xs text-destructive">
            {t('userMenu.switchOrganizationFailed')}
          </p>
        )}
      </DropdownMenuSubContent>
    </DropdownMenuSub>
  )
}
