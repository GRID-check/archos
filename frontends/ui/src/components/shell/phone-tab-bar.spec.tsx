import { forwardRef, type AnchorHTMLAttributes, type ReactNode } from 'react'
import { render, screen, within } from '@/test-utils'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, test, vi } from 'vitest'

import { useLayoutStore } from '@/features/layout/store'
import { PhoneTabBar } from './phone-tab-bar'

let pathname = '/app/projects/p1/files'
vi.mock('next/navigation', () => ({
  usePathname: () => pathname,
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

const badge = vi.fn((enabled: boolean) => ({
  pending: enabled ? 3 : 0,
  connected: true,
  refresh: () => {},
}))
vi.mock('@/features/collaboration/hooks/use-inbox', () => ({
  useInboxBadge: (enabled: boolean) => badge(enabled),
}))

let mobile = true
vi.mock('@/hooks/use-is-mobile', () => ({
  useIsMobile: () => mobile,
}))

afterEach(() => {
  pathname = '/app/projects/p1/files'
  mobile = true
  badge.mockClear()
  useLayoutStore.setState({ isMobileNavOpen: false })
})

const bar = (): HTMLElement => screen.getByRole('navigation', { name: 'Main navigation' })

describe('PhoneTabBar — inside a project', () => {
  test('five tabs, labelled as the rail labels them, the current one marked', () => {
    render(<PhoneTabBar projectId="p1" canAccessArchiv canAccessInbox />)
    const links = within(bar()).getAllByRole('link')
    expect(links.map((link) => link.textContent)).toEqual([
      'Ask Piloti',
      'Files',
      'Overview',
      expect.stringContaining('Inbox'),
    ])
    expect(within(bar()).getByRole('link', { name: 'Files' })).toHaveAttribute(
      'aria-current',
      'page'
    )
    expect(within(bar()).getByRole('button', { name: 'More' })).toBeInTheDocument()
    // Exactly one chip, on the current tab.
    const pills = bar().querySelectorAll('[data-slot="phone-tab-pill"]')
    expect(pills).toHaveLength(1)
    expect(pills[0]!.closest('a')).toHaveTextContent('Files')
  })

  test('"Mehr" opens the drawer the rail becomes on a phone', async () => {
    const user = userEvent.setup()
    render(<PhoneTabBar projectId="p1" canAccessArchiv canAccessInbox />)
    const more = within(bar()).getByRole('button', { name: 'More' })
    expect(more).toHaveAttribute('aria-expanded', 'false')

    await user.click(more)

    expect(useLayoutStore.getState().isMobileNavOpen).toBe(true)
    expect(more).toHaveAttribute('aria-expanded', 'true')
  })

  test('the Postfach carries its badge on a phone', () => {
    render(<PhoneTabBar projectId="p1" canAccessArchiv canAccessInbox />)
    expect(within(bar()).getByTestId('inbox-badge')).toHaveAttribute('data-pending', '3')
  })

  test('at md and up the bar is display:none and opens no badge subscription of its own', () => {
    mobile = false
    render(<PhoneTabBar projectId="p1" canAccessArchiv canAccessInbox />)
    expect(bar().className).toContain('md:hidden')
    expect(badge).toHaveBeenCalledWith(false)
    expect(within(bar()).queryByTestId('inbox-badge')).toBeNull()
  })

  test('every tab is a 52px row (44px on its side), and owns the home-indicator inset', () => {
    render(<PhoneTabBar projectId="p1" canAccessArchiv canAccessInbox />)
    expect(bar().className).toContain('pb-[env(safe-area-inset-bottom)]')
    for (const tab of [
      ...within(bar()).getAllByRole('link'),
      within(bar()).getByRole('button', { name: 'More' }),
    ]) {
      expect(tab.className).toContain('h-[3.25rem]')
      expect(tab.className).toContain('[@media(max-height:31rem)]:h-11')
    }
  })

  test('a preview can pin the route it stands in for', () => {
    pathname = '/dev/app-rail'
    render(
      <PhoneTabBar projectId="p1" canAccessArchiv canAccessInbox pathname="/app/projects/p1/chat" />
    )
    expect(within(bar()).getByRole('link', { name: 'Ask Piloti' })).toHaveAttribute(
      'aria-current',
      'page'
    )
  })
})

describe('PhoneTabBar — above a project', () => {
  test('Projekte, the Büroablage and the Postfach, no "Mehr"', () => {
    pathname = '/app/projects'
    render(<PhoneTabBar projectId={null} canAccessArchiv canAccessInbox />)
    const links = within(bar()).getAllByRole('link')
    expect(links.map((link) => link.getAttribute('href'))).toEqual([
      '/app/projects',
      '/app/archiv',
      '/app/inbox',
    ])
    expect(within(bar()).getByRole('link', { name: 'Projects' })).toHaveAttribute(
      'aria-current',
      'page'
    )
    expect(within(bar()).queryByRole('button')).toBeNull()
  })
})
