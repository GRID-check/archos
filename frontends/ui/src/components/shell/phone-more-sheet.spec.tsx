import { forwardRef, type AnchorHTMLAttributes, type ReactNode } from 'react'
import { render, screen, within } from '@/test-utils'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, test, vi } from 'vitest'

import { PhoneMoreSheet } from './phone-more-sheet'
import { PhoneTabBar } from './phone-tab-bar'
import { useShellOverlays } from './shell-overlays'

vi.mock('next/navigation', () => ({ usePathname: () => '/app/projects/p1/files' }))
vi.mock('next/link', () => ({
  default: forwardRef<HTMLAnchorElement, { href: string; children: ReactNode } & AnchorHTMLAttributes<HTMLAnchorElement>>(
    function MockLink({ href, children, ...rest }, ref) {
      return (
        <a ref={ref} href={href} {...rest}>
          {children}
        </a>
      )
    }
  ),
}))
vi.mock('@/features/collaboration/hooks/use-inbox', () => ({
  useInboxBadge: () => ({ pending: 0, connected: true, refresh: () => {} }),
}))
vi.mock('@/adapters/auth/use-auth', () => ({ useAuth: () => ({ user: null, signOut: vi.fn() }) }))
vi.mock('@/hooks/use-is-mobile', () => ({ useIsMobile: () => true }))

afterEach(() => useShellOverlays.setState({ moreSheetOpen: false }))

const flags = {
  canAccessOfficeShelf: true,
  canAccessInbox: true,
  showSkills: true,
  canViewOrganization: true,
  canManageOrganization: false,
  canManagePlatform: false,
}

describe('PhoneMoreSheet', () => {
  test('a tap on "Mehr" opens a sheet with only what the bar lacks, and the account', async () => {
    const user = userEvent.setup()
    render(
      <>
        <PhoneTabBar projectId="p1" canAccessOfficeShelf canAccessInbox />
        <PhoneMoreSheet projectId="p1" authRequired {...flags} />
      </>
    )
    expect(screen.queryByRole('dialog')).toBeNull()

    await user.click(screen.getByRole('button', { name: 'More' }))

    const sheet = await screen.findByRole('dialog')
    const links = within(sheet).getAllByRole('link').map((link) => link.getAttribute('data-destination'))
    expect(links).toEqual(['automation', 'officeShelf', 'profile', 'organization'])
    // None of the bar's own tabs is repeated.
    for (const name of ['Ask Piloti', 'Files', 'Overview']) {
      expect(within(sheet).queryByRole('link', { name })).toBeNull()
    }
    expect(within(sheet).getByRole('button', { name: /sign out/i })).toBeInTheDocument()
  })
})
