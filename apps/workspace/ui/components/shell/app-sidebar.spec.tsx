import { forwardRef, type AnchorHTMLAttributes, type ReactNode } from 'react'
import { render, screen, act, within } from '@/test-utils'
import userEvent from '@testing-library/user-event'
import { vi, describe, test, expect, afterEach } from 'vitest'
import { useIsMobile } from '@/hooks/use-is-mobile'
import { useLayoutStore } from '@/features/layout/store'
import { useShellOverlays } from './shell-overlays'
import { I18nProvider } from '@/i18n'
import { AppSidebar, railActivePillId } from './app-sidebar'

// Isolate the nav-filtering logic from routing and the shell's sibling widgets.
// The pathname is mutable because the rail now reads its own scope from it —
// project scope inside `/app/projects/<id>/…`, org scope everywhere above.
let pathname = '/app/projects/p1/chat'
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

vi.mock('@/hooks/use-last-project-section', () => ({
  useRecordProjectSection: () => {},
  pruneProjectSections: () => {},
}))

vi.mock('./project-switcher', () => ({ ProjectSwitcher: () => <div />, ProjectStatusDot: () => <span /> }))
vi.mock('./connection-band', () => ({ ConnectionBand: () => <div data-testid="connection-band" /> }))
vi.mock('./sidebar-user-menu', () => ({ SidebarUserMenu: () => <div /> }))
vi.mock('./connection-presence-indicator', () => ({
  ConnectionPresenceIndicator: () => <div />,
}))
vi.mock('@/components/brand/logo', () => ({ Logo: () => <div /> }))

// Only the hook is stood in for: the module's named queries stay real.
vi.mock('@/hooks/use-is-mobile', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/hooks/use-is-mobile')>()),
  useIsMobile: vi.fn(() => false),
}))

const baseProps = {
  projectId: 'p1',
  projects: [{ id: 'p1', name: 'Project One' }],
  authRequired: false,
  // Explicit, and `true`, because these tests are about the nav a real user sees.
  // This prop used to default to `false` and this fixture omitted it, so every
  // test below silently asserted the rail with the Inbox entry HIDDEN — the state
  // no signed-in member of an org is in.
  canAccessInbox: true,
}

afterEach(() => {
  pathname = '/app/projects/p1/chat'
  // The primitive persists collapse in localStorage, so a test that collapses
  // the rail used to hand the icon rail to every test that ran after it.
  window.localStorage.removeItem('sidebar.collapsed')
  vi.mocked(useIsMobile).mockReturnValue(false)
  useLayoutStore.setState({ isMobileNavOpen: false })
  useShellOverlays.setState({ projectSheetOpen: false, paletteOpen: false })
})

describe('the Inbox entry follows canAccessInbox, in both directions', () => {
  // Both states, because the prop was optional and defaulting to `false` meant
  // the disabled state was the only one this file ever covered.
  test('shows the entry when the reader may reach the inbox', () => {
    render(<AppSidebar {...baseProps} canAccessInbox />)
    expect(screen.getAllByText('Inbox').length).toBeGreaterThan(0)
  })

  test('hides it when they may not', () => {
    render(<AppSidebar {...baseProps} canAccessInbox={false} />)
    expect(screen.queryByText('Inbox')).not.toBeInTheDocument()
  })
})

describe('AppSidebar - click-dummy IA (FB-9/FB-10)', () => {
  test('renders the core nav set: Ask Piloti, Files', () => {
    render(<AppSidebar {...baseProps} />)
    expect(screen.getAllByText('Ask Piloti').length).toBeGreaterThan(0)
    expect(screen.getAllByText('Files').length).toBeGreaterThan(0)
  })

  test('Members, Research, Knowledge and History no longer appear in the nav', () => {
    render(<AppSidebar {...baseProps} canAccessOfficeShelf />)
    // "Overview" is back, but as the label of the pinned project hub (the
    // settings segment), not the old top-level Overview route: see the next test.
    expect(screen.queryByText('Members')).not.toBeInTheDocument()
    expect(screen.queryByText('Research')).not.toBeInTheDocument()
    expect(screen.queryByText('Knowledge')).not.toBeInTheDocument()
    // History left the rail — the chat toolbar's history sheet is the record.
    expect(screen.queryByText('History')).not.toBeInTheDocument()
  })

  test('renders the pinned Overview entry linking to the project hub', () => {
    render(<AppSidebar {...baseProps} />)
    const links = screen.getAllByText('Overview').map((el) => el.closest('a'))
    expect(links.length).toBeGreaterThan(0)
    for (const link of links) {
      expect(link).toHaveAttribute('href', '/app/projects/p1/settings')
    }
  })

  test('Ask Piloti links to a FRESH chat (?new=1), not the last thread', () => {
    render(<AppSidebar {...baseProps} />)
    // Filter to actual nav links — on the chat route the mobile top bar also
    // renders "Ask Piloti" as a plain active-section label (not an anchor).
    const links = screen
      .getAllByText('Ask Piloti')
      .map((el) => el.closest('a'))
      .filter((link): link is HTMLAnchorElement => link !== null)
    expect(links.length).toBeGreaterThan(0)
    for (const link of links) {
      expect(link).toHaveAttribute('href', '/app/projects/p1/chat?new=1')
    }
  })

})

describe('AppSidebar - Automation nav item', () => {
  test('hides the Automation nav item by default (feature-flagged, default off)', () => {
    render(<AppSidebar {...baseProps} />)
    expect(screen.queryByText('Automation')).not.toBeInTheDocument()
    // Sibling items remain.
    expect(screen.getAllByText('Ask Piloti').length).toBeGreaterThan(0)
    expect(screen.getAllByText('Files').length).toBeGreaterThan(0)
  })

  test('shows the Automation nav item when showSkills is true, linking to the merged section', () => {
    render(<AppSidebar {...baseProps} showSkills />)
    const links = screen
      .getAllByText('Automation')
      .map((el) => el.closest('a'))
      .filter((link): link is HTMLAnchorElement => link !== null)
    expect(links.length).toBeGreaterThan(0)
    for (const link of links) {
      expect(link).toHaveAttribute('href', '/app/projects/p1/automation')
    }
  })
})

describe('AppSidebar - office shelf nav item (ADR-0024)', () => {
  test('shows office shelf when canAccessOfficeShelf is true, linking to the org office shelf', () => {
    render(<AppSidebar {...baseProps} canAccessOfficeShelf />)
    const links = screen.getAllByText('Office filing').map((el) => el.closest('a'))
    expect(links.length).toBeGreaterThan(0)
    for (const link of links) {
      expect(link).toHaveAttribute('href', '/app/office-shelf')
    }
  })

  test('hides office shelf by default (org feature flag off)', () => {
    render(<AppSidebar {...baseProps} />)
    expect(screen.queryByText('Office filing')).not.toBeInTheDocument()
  })

  test('orders Ask Piloti first and Inbox last in the section nav', () => {
    const { container } = render(<AppSidebar {...baseProps} canAccessOfficeShelf />)
    // Scope to the rail's own <nav> elements so the wordmark / Settings footer
    // stay out. Archiv and Inbox are the bottom-pinned org group — a second,
    // sibling <nav> outside `[data-sidebar="content"]` — so this reads every
    // `nav` under the sidebar root rather than just the scrollable one.
    const navs = container.querySelectorAll('[data-sidebar="sidebar"] nav')
    expect(navs.length).toBeGreaterThan(0)
    const labels = Array.from(navs)
      .flatMap((nav) => Array.from(nav.querySelectorAll('a span[data-slot="rail-nav-label"]')))
      .map((el) => el.textContent)
    // Ask Piloti · Files · Automation* · Archiv* · Suche · Inbox*,
    // per `project-sections.ts`. Automation is absent here because `showSkills`
    // is off.
    expect(labels).toEqual(['Ask Piloti', 'Files', 'Office filing', 'Search', 'Inbox'])
  })
})

describe('AppSidebar - collapsed icon rail', () => {
  test('keeps nav labels in the a11y tree but does not paint them', async () => {
    const user = userEvent.setup()
    render(<AppSidebar {...baseProps} />)

    const sections = screen.getByLabelText('Project sections')
    expect(within(sections).getByText('Ask Piloti')).toBeVisible()
    expect(within(sections).getByText('Work')).toBeVisible()

    await user.click(screen.getByRole('button', { name: 'Collapse sidebar' }))

    // Named for AT (sr-only), not painted in the 64px rail. Happy-dom treats
    // sr-only as visible, so we assert the class rather than toBeVisible.
    expect(within(sections).getByText('Ask Piloti')).toHaveClass('sr-only')
    expect(within(sections).getByText('Files')).toHaveClass('sr-only')
    expect(within(sections).queryByText('Work')).not.toBeInTheDocument()
  })
})

describe('AppSidebar - the resize edge', () => {
  // The primitive ships English strings of its own; the rail is a tab stop now,
  // so the one control a keyboard user lands on must be named from the
  // dictionary like the rest of the nav. This is the JOIN — the primitive's
  // props and the dictionary keys are each correct on their own, and neither
  // side notices when nobody passes them.
  //
  // Asserted in GERMAN on purpose: in English the dictionary's strings and the
  // primitive's own defaults are the same words, so an English assertion passes
  // just as happily with the props removed. It was written that way first, and
  // that version survived deleting the very wiring it was written to pin.
  const renderGerman = (): void => {
    render(
      <I18nProvider initialLocale="de" fixedLocale>
        <AppSidebar {...baseProps} />
      </I18nProvider>
    )
  }

  test('names the edge from the dictionary, in both of its states', async () => {
    const user = userEvent.setup()
    renderGerman()

    const edge = screen.getByRole('separator', { name: 'Breite der Seitenleiste ändern' })
    expect(edge).toHaveAttribute('title', 'Ziehen zum Ändern der Breite, klicken zum Einklappen')

    await user.click(screen.getByRole('button', { name: 'Seitenleiste einklappen' }))

    // From the icon column there is no width to change yet, only a rail to
    // bring back — so the hint follows the state the rail is in.
    expect(screen.getByRole('separator', { name: 'Breite der Seitenleiste ändern' })).toHaveAttribute(
      'title',
      'Ziehen oder klicken zum Ausklappen'
    )
  })
})

describe('AppSidebar - mobile top bar', () => {
  test('hides the standalone mobile top bar on the chat route (chat owns its chrome)', () => {
    // The mocked pathname is the chat route, so the banner must carry `hidden`
    // — the chat's floating toolbar hosts the nav opener there instead.
    render(<AppSidebar {...baseProps} />)
    const banner = screen.getByRole('banner')
    expect(banner.className).toContain('hidden')
    expect(banner.className).not.toMatch(/(^|\s)flex(\s|$)/)
  })
})

describe('AppSidebar - the phone top band', () => {
  test("names the project, and opens the switcher sheet from it", async () => {
    pathname = '/app/projects/p1/files'
    const user = userEvent.setup()
    render(<AppSidebar {...baseProps} />)
    const pill = within(screen.getByRole('banner')).getByTestId('project-pill')
    expect(pill).toHaveTextContent('Project One')
    expect(pill).toHaveAttribute('aria-expanded', 'false')

    await user.click(pill)

    expect(useShellOverlays.getState().projectSheetOpen).toBe(true)
  })

  test('carries the search that opens the command palette', async () => {
    pathname = '/app/projects/p1/files'
    const user = userEvent.setup()
    render(<AppSidebar {...baseProps} />)
    await user.click(within(screen.getByRole('banner')).getByTestId('shell-search'))
    expect(useShellOverlays.getState().paletteOpen).toBe(true)
  })

  test('offers a way back from a page one level below a tab, and none on a tab root', () => {
    pathname = '/app/projects/p1/files/bin'
    const { unmount } = render(<AppSidebar {...baseProps} />)
    expect(within(screen.getByRole('banner')).getByRole('link', { name: 'Back to Files' })).toHaveAttribute(
      'href',
      '/app/projects/p1/files'
    )
    unmount()

    pathname = '/app/projects/p1/files'
    render(<AppSidebar {...baseProps} />)
    expect(within(screen.getByRole('banner')).queryByRole('link', { name: /^Back to/ })).toBeNull()
  })

  test('shows the connection on a phone, where the rail footer is out of sight', () => {
    pathname = '/app/projects/p1/files'
    vi.mocked(useIsMobile).mockReturnValue(true)
    render(<AppSidebar {...baseProps} />)
    expect(within(screen.getByRole('banner')).getByTestId('connection-band')).toBeInTheDocument()
  })
})

describe('AppSidebar - active state', () => {
  test('marks the Chat item as the current page on the chat route', () => {
    render(<AppSidebar {...baseProps} />)
    const chatLinks = screen.getAllByText('Ask Piloti').map((el) => el.closest('a'))
    expect(chatLinks.some((link) => link?.getAttribute('aria-current') === 'page')).toBe(true)
    const settingsLinks = screen.getAllByText('Overview').map((el) => el.closest('a'))
    for (const link of settingsLinks) {
      expect(link).not.toHaveAttribute('aria-current')
    }
  })

  test('draws the shared-layout pill on the active entry, and nowhere else', () => {
    // The pill is what the active state IS now — the button no longer carries
    // `bg-card`/`border`, so "exactly one pill, inside the current link" is the
    // assertion that the active surface still exists at all.
    const { container } = render(<AppSidebar {...baseProps} />)
    const pills = Array.from(container.querySelectorAll('[data-slot="rail-active-pill"]'))
    expect(pills).toHaveLength(1)
    expect(pills[0]!.closest('a')).toHaveAttribute('aria-current', 'page')
    expect(pills[0]!.closest('a')).toHaveTextContent('Ask Piloti')
  })

  test('keys the pill identity by rail width, so it never scales across a collapse', () => {
    // `layoutId` is motion state, not a DOM attribute, so the animation itself
    // is not observable from a jsdom render — but the KEY is, and the key is
    // the whole design decision. The two widths must separate, or a collapse
    // would scale a 212px chip into a 36px one and smear its border.
    expect(railActivePillId(false)).not.toBe(railActivePillId(true))
    // Entries WITHIN one rail must share it — that is what makes the glide a
    // glide rather than independent chips.
    expect(railActivePillId(false)).toBe(railActivePillId(false))
  })
})

describe('AppSidebar - layout store mobile nav sync', () => {
  test('opens the primitive sheet when the chat toolbar sets the store', async () => {
    vi.mocked(useIsMobile).mockReturnValue(true)
    render(<AppSidebar {...baseProps} />)
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()

    await act(async () => {
      useLayoutStore.getState().setMobileNavOpen(true)
    })

    expect(await screen.findByRole('dialog')).toBeInTheDocument()
    expect(screen.getAllByText('Ask Piloti').length).toBeGreaterThan(0)
  })
})

describe('AppSidebar - the org doorways stay reachable from inside a project', () => {
  test('marks the office shelf doorway current while its sheet is open over the project', () => {
    // Opening the Archiv from a project is an intercepted route: the URL is
    // `/app/office-shelf` while the project page (and this rail) keep standing under
    // the sheet. The rail must say where the reader IS — the doorway — without
    // un-marking the project scope it is still rendering.
    pathname = '/app/office-shelf'
    render(<AppSidebar {...baseProps} canAccessOfficeShelf />)
    const officeShelf = screen
      .getAllByText('Office filing')
      .map((el) => el.closest('a'))
      .filter((link): link is HTMLAnchorElement => link !== null)
    expect(officeShelf.some((link) => link.getAttribute('aria-current') === 'page')).toBe(true)
    // The project's own sections are still offered — the project did not go away.
    expect(screen.getAllByText('Files').length).toBeGreaterThan(0)
  })
})
