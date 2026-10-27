/**
 * „Switch organization" in the avatar menu: the person's offices, AuthKit's
 * switch, and what happens after it.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { render, screen } from '@/test-utils'
import userEvent from '@testing-library/user-event'

const switchToOrganization = vi.fn()
vi.mock('@workos-inc/authkit-nextjs/components', () => ({ useAuth: () => ({ switchToOrganization }) }))

const assign = vi.fn()

import { DropdownMenu, DropdownMenuContent, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { OrganizationSwitcherMenu } from './organization-switcher'

const ORGANIZATIONS = [
  { id: 'org_1', name: 'GRID Test', current: true },
  { id: 'org_2', name: 'feld72 Architekten', current: false },
]

async function openSwitcher() {
  render(
    <DropdownMenu>
      <DropdownMenuTrigger>menu</DropdownMenuTrigger>
      <DropdownMenuContent>
        <OrganizationSwitcherMenu organizations={ORGANIZATIONS} />
      </DropdownMenuContent>
    </DropdownMenu>,
  )
  await userEvent.click(screen.getByRole('button', { name: 'menu' }))
  await userEvent.click(await screen.findByTestId('user-menu-switch-organization'))
}

beforeEach(() => {
  vi.stubGlobal('location', { ...window.location, assign })
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.clearAllMocks()
})

describe('OrganizationSwitcherMenu', () => {
  test('lists every office, the current one marked and not offered', async () => {
    await openSwitcher()

    expect(await screen.findByRole('menuitem', { name: /feld72 Architekten/ })).not.toHaveAttribute('data-disabled')
    expect(screen.getByRole('menuitem', { name: /GRID Test/ })).toHaveAttribute('data-disabled')
  })

  test('switches the session, then loads the new office’s projects', async () => {
    switchToOrganization.mockResolvedValue({})
    await openSwitcher()

    await userEvent.click(await screen.findByRole('menuitem', { name: /feld72 Architekten/ }))

    expect(switchToOrganization).toHaveBeenCalledWith('org_2')
    expect(assign).toHaveBeenCalledWith('/app/projects')
  })

  test('leaves an SSO or MFA sign-in to the redirect Next is already following', async () => {
    switchToOrganization.mockRejectedValue(Object.assign(new Error('NEXT_REDIRECT'), { digest: 'NEXT_REDIRECT;push;https://auth.workos.com/sso;307;' }))
    await openSwitcher()

    await userEvent.click(await screen.findByRole('menuitem', { name: /feld72 Architekten/ }))

    expect(assign).not.toHaveBeenCalled()
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  test('says so when the switch fails, and stays where it is', async () => {
    switchToOrganization.mockRejectedValue(new Error('refresh failed'))
    await openSwitcher()

    await userEvent.click(await screen.findByRole('menuitem', { name: /feld72 Architekten/ }))

    expect(assign).not.toHaveBeenCalled()
    expect(await screen.findByRole('alert')).toBeInTheDocument()
  })
})
