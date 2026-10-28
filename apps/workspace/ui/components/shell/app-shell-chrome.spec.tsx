import { render, screen } from '@/test-utils'
import { vi, describe, test, expect, afterEach } from 'vitest'
import { AppShellChrome } from './app-shell-chrome'

// The chrome DECIDES which shape stands; the shapes themselves are covered by
// their own specs. Stubs keep the decision observable without mounting a rail.
let pathname = '/app/projects/p1/chat'
vi.mock('next/navigation', () => ({
  usePathname: () => pathname,
  useSearchParams: () => null,
  useRouter: () => ({ replace: vi.fn() }),
}))
vi.mock('./app-sidebar', () => ({
  AppSidebar: ({ projectId }: { projectId: string }) => (
    <div data-testid="rail" data-project-id={projectId} />
  ),
}))
vi.mock('./org-header', () => ({
  OrgHeader: () => <div data-testid="org-header" />,
}))
vi.mock('@/features/onboarding/components/product-tour', () => ({
  ProductTour: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}))
vi.mock('./phone-tab-bar', () => ({
  PhoneTabBar: ({ projectId }: { projectId: string | null }) => (
    <nav data-testid="tab-bar" data-project-id={projectId ?? 'org'} />
  ),
}))
vi.mock('./phone-more-sheet', () => ({
  PhoneMoreSheet: () => <div data-testid="more-sheet" />,
}))
vi.mock('./project-switcher-sheet', () => ({
  ProjectSwitcherSheet: () => <div data-testid="switcher-sheet" />,
}))
let keyboardUp = false
vi.mock('./use-keyboard-up', () => ({
  useKeyboardUp: () => keyboardUp,
}))

const baseProps = {
  projects: [],
  authRequired: false,
  canManageOrganization: false,
  canViewOrganization: false,
  canManagePlatform: false,
  canAccessOfficeShelf: true,
  canAccessInbox: true,
  showSkills: false,
  showModels: false,
  tours: { welcome: false, project: false },
  overlay: null,
}

afterEach(() => {
  pathname = '/app/projects/p1/chat'
  keyboardUp = false
})

describe('AppShellChrome — which chrome stands', () => {
  test('inside a project: the rail, with that project id', () => {
    render(<AppShellChrome {...baseProps}>page</AppShellChrome>)
    expect(screen.getByTestId('rail')).toHaveAttribute('data-project-id', 'p1')
    expect(screen.queryByTestId('org-header')).not.toBeInTheDocument()
  })

  test('above a project: the org header, full stop', () => {
    pathname = '/app/projects'
    render(<AppShellChrome {...baseProps}>page</AppShellChrome>)
    expect(screen.getByTestId('org-header')).toBeInTheDocument()
    expect(screen.queryByTestId('rail')).not.toBeInTheDocument()
  })
})

describe('AppShellChrome — overlay routes keep the chrome of the covered page', () => {
  test('opening the office shelf over a project keeps the project rail standing', () => {
    // An intercepted navigation changes the URL to /app/office-shelf while the
    // segment below keeps rendering the project page. Flipping the rail into
    // the org header UNDER the sheet is the reflow this logic exists to
    // prevent.
    const { rerender } = render(<AppShellChrome {...baseProps}>page</AppShellChrome>)
    pathname = '/app/office-shelf'
    rerender(<AppShellChrome {...baseProps}>page</AppShellChrome>)
    expect(screen.getByTestId('rail')).toHaveAttribute('data-project-id', 'p1')
    expect(screen.queryByTestId('org-header')).not.toBeInTheDocument()
  })

  test('opening the Postfach over the org home keeps the org header standing', () => {
    pathname = '/app/projects'
    const { rerender } = render(<AppShellChrome {...baseProps}>page</AppShellChrome>)
    pathname = '/app/inbox'
    rerender(<AppShellChrome {...baseProps}>page</AppShellChrome>)
    expect(screen.getByTestId('org-header')).toBeInTheDocument()
  })

  test('a hard load of an overlay URL has no covered page — org header stands', () => {
    pathname = '/app/office-shelf'
    render(<AppShellChrome {...baseProps}>page</AppShellChrome>)
    expect(screen.getByTestId('org-header')).toBeInTheDocument()
    expect(screen.queryByTestId('rail')).not.toBeInTheDocument()
  })

  test('navigating on from an overlay releases the remembered scope', () => {
    const { rerender } = render(<AppShellChrome {...baseProps}>page</AppShellChrome>)
    pathname = '/app/office-shelf'
    rerender(<AppShellChrome {...baseProps}>page</AppShellChrome>)
    pathname = '/app/projects'
    rerender(<AppShellChrome {...baseProps}>page</AppShellChrome>)
    expect(screen.getByTestId('org-header')).toBeInTheDocument()
    expect(screen.queryByTestId('rail')).not.toBeInTheDocument()
  })
})

describe('AppShellChrome — height', () => {
  test('the frame follows the visual viewport while the iOS keyboard is up, 100dvh otherwise', () => {
    // useVisualViewport publishes the variable only while the keyboard
    // occludes the layout viewport; the fallback is what every other browser
    // gets. A bare `h-dvh` here puts the composer behind the iOS keyboard.
    const { container } = render(<AppShellChrome {...baseProps}>page</AppShellChrome>)
    const frame = container.querySelector('.overflow-hidden')
    expect(frame?.className).toContain('h-[var(--visual-viewport-height,100dvh)]')
  })
})

describe('AppShellChrome — the phone tab bar', () => {
  test('stands after the page in both scopes, carrying the scope it is in', () => {
    const { container, unmount } = render(<AppShellChrome {...baseProps}>page</AppShellChrome>)
    const bar = screen.getByTestId('tab-bar')
    expect(bar).toHaveAttribute('data-project-id', 'p1')
    // In flow, after the page: the scroll container ends where the bar begins,
    // so nothing scrolls under it and no page reserves its height.
    const frame = container.querySelector('[data-tab-bar]')!
    expect(Array.from(frame.children).indexOf(bar)).toBeGreaterThan(0)
    expect(screen.getByTestId('switcher-sheet')).toBeInTheDocument()
    unmount()

    pathname = '/app/projects'
    render(<AppShellChrome {...baseProps}>page</AppShellChrome>)
    expect(screen.getByTestId('tab-bar')).toHaveAttribute('data-project-id', 'org')
    // No project, nothing to switch between.
    expect(screen.queryByTestId('switcher-sheet')).toBeNull()
  })

  test('stands down while the keyboard is up, and zeroes the inset a composer pads for', () => {
    keyboardUp = true
    const { container } = render(<AppShellChrome {...baseProps}>page</AppShellChrome>)
    expect(screen.queryByTestId('tab-bar')).toBeNull()
    const frame = container.querySelector('[data-tab-bar]')!
    expect(frame).toHaveAttribute('data-tab-bar', 'hidden')
    expect(frame).toHaveAttribute('data-keyboard', 'up')
    expect(frame.className).toContain('data-[keyboard=up]:[--shell-inset-bottom:0px]')
  })

  test('the chat route on a phone always has a way to the navigation: the bar returns when the keyboard goes', () => {
    // The chat toolbar has no menu button of its own on a phone; the bar's
    // "Mehr" is the door to the drawer there. Composing may take the bar away
    // for as long as the keyboard covers it, and not one frame longer.
    pathname = '/app/projects/p1/chat'
    keyboardUp = true
    const { rerender } = render(<AppShellChrome {...baseProps}>page</AppShellChrome>)
    expect(screen.queryByTestId('tab-bar')).toBeNull()

    keyboardUp = false
    rerender(<AppShellChrome {...baseProps}>page</AppShellChrome>)
    expect(screen.getByTestId('tab-bar')).toHaveAttribute('data-project-id', 'p1')
  })

  test('stands down on the intake wizard, which has its own footer', () => {
    pathname = '/app/projects/p1/intake'
    render(<AppShellChrome {...baseProps}>page</AppShellChrome>)
    expect(screen.queryByTestId('tab-bar')).toBeNull()
  })

  test('while it stands, the page below is told the bar clears the home indicator', () => {
    const { container } = render(<AppShellChrome {...baseProps}>page</AppShellChrome>)
    const frame = container.querySelector('[data-tab-bar]')!
    expect(frame).toHaveAttribute('data-tab-bar', 'shown')
    expect(frame.className).toContain('[--shell-inset-bottom:env(safe-area-inset-bottom)]')
    expect(frame.className).toContain('max-md:data-[tab-bar=shown]:[--shell-inset-bottom:0px]')
  })
})
