import { forwardRef, type AnchorHTMLAttributes, type ReactNode } from 'react'
import { render, screen } from '@/test-utils'
import { vi, describe, test, expect, afterEach } from 'vitest'
import { OrgHeader } from './org-header'
import { useShellOverlays } from './shell-overlays'

let pathname = '/app/projects'
vi.mock('next/navigation', () => ({
  usePathname: () => pathname,
  useRouter: () => ({ back: vi.fn(), push: vi.fn(), replace: vi.fn() }),
}))

vi.mock('next/link', () => ({
  default: forwardRef<
    HTMLAnchorElement,
    { href: string; children: ReactNode } & AnchorHTMLAttributes<HTMLAnchorElement>
  >(function MockLink({ href, children, ...rest }, ref) {
    return (
      <a ref={ref} href={href} {...rest}>
        {children}
      </a>
    )
  }),
}))

vi.mock('./sidebar-user-menu', () => ({
  SidebarUserMenu: () => <div data-testid="user-menu" />,
}))

// The badge subscription is the hook's own concern; here only the count's
// placement matters.
let pending = 0
vi.mock('@/features/collaboration/hooks/use-inbox', () => ({
  useInboxBadge: () => ({ pending }),
}))

const baseProps = {
  user: { name: 'Anna Berger', email: 'anna.berger@example.at' },
  organizationName: 'Musterarchitektur ZT GmbH',
  authRequired: false,
  canManageOrganization: false,
  canViewOrganization: false,
  canManagePlatform: false,
  canAccessOfficeShelf: true,
  canAccessInbox: true,
}

let mobile = false
vi.mock('@/hooks/use-is-mobile', () => ({
  useIsMobile: () => mobile,
}))
vi.mock('./connection-band', () => ({ ConnectionBand: () => <div data-testid="connection-band" /> }))
// WorkOS's widget needs a live token; the header decides only whether it is there.
vi.mock('./organization-switcher', () => ({ default: () => <div data-testid="workos-organization-switcher" /> }))

afterEach(() => {
  pathname = '/app/projects'
  pending = 0
  mobile = false
  useShellOverlays.setState({ paletteOpen: false })
})

describe('OrgHeader — the org scope in one slim band', () => {
  test('carries the wordmark home link, both doorways, and the avatar menu', () => {
    render(<OrgHeader {...baseProps} />)
    expect(screen.getByText('Piloti').closest('a')).toHaveAttribute('href', '/app/projects')
    expect(screen.getByLabelText('Office filing')).toHaveAttribute('href', '/app/office-shelf')
    expect(screen.getByLabelText('Inbox')).toHaveAttribute('href', '/app/inbox')
    expect(screen.getByTestId('user-menu')).toBeInTheDocument()
  })

  test('drops each doorway with its own gate', () => {
    render(<OrgHeader {...baseProps} canAccessOfficeShelf={false} canAccessInbox={false} />)
    expect(screen.queryByLabelText('Office filing')).not.toBeInTheDocument()
    expect(screen.queryByLabelText('Inbox')).not.toBeInTheDocument()
    // The avatar stays — the header is never just a wordmark.
    expect(screen.getByTestId('user-menu')).toBeInTheDocument()
  })

  test('marks the doorway whose sheet is open, and only that one', () => {
    pathname = '/app/office-shelf'
    render(<OrgHeader {...baseProps} />)
    expect(screen.getByLabelText('Office filing')).toHaveAttribute('aria-current', 'page')
    expect(screen.getByLabelText('Inbox')).not.toHaveAttribute('aria-current')
  })

  test('surfaces the pending count on the inbox doorway', () => {
    pending = 3
    render(<OrgHeader {...baseProps} />)
    const inbox = screen.getByLabelText('Inbox')
    expect(inbox.textContent).toContain('3')
  })
})

describe('OrgHeader — on a phone', () => {
  test('the doorways give way to the tab bar; search opens the palette', () => {
    mobile = true
    render(<OrgHeader {...baseProps} />)
    // Hidden by CSS below `md` (the tab bar carries them), still the desktop's.
    expect(screen.getByLabelText('Office filing').className).toMatch(/(^|\s)hidden(\s|$)/)
    expect(screen.getByLabelText('Office filing').className).toContain('md:flex')
    const search = screen.getByTestId('shell-search')
    expect(search.className).toContain('md:hidden')
    expect(search.className).toContain('pointer-coarse:size-11')
    search.click()
    expect(useShellOverlays.getState().paletteOpen).toBe(true)
  })

  test('says when the connection is gone, in the band rather than a drawer', () => {
    mobile = true
    render(<OrgHeader {...baseProps} />)
    expect(screen.getByTestId('connection-band')).toBeInTheDocument()
  })

  test('leaves the desktop band as it was: no presence ping of its own', () => {
    render(<OrgHeader {...baseProps} />)
    expect(screen.queryByTestId('connection-band')).toBeNull()
  })
})

describe('the organization switcher', () => {
  test('stands beside the wordmark for someone in several organizations', async () => {
    render(<OrgHeader {...baseProps} canSwitchOrganization />)

    expect(await screen.findByTestId('workos-organization-switcher')).toBeInTheDocument()
  })

  test('is not there for someone in one organization', () => {
    render(<OrgHeader {...baseProps} />)

    expect(screen.queryByTestId('organization-switcher')).not.toBeInTheDocument()
  })
})
