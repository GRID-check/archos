import { forwardRef, type AnchorHTMLAttributes, type ReactNode } from 'react'
import { act, render, screen, within } from '@/test-utils'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'

import { ProjectSwitcherSheet, switcherSheetSections } from './project-switcher-sheet'
import { RECENT_PROJECTS_STORAGE_KEY, withRecentProject } from './recent-projects'
import { useShellOverlays } from './shell-overlays'

const push = vi.fn()
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push, replace: vi.fn(), back: vi.fn() }),
  usePathname: () => '/app/projects/a/files',
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

const PROJECTS = [
  { id: 'a', name: 'Amtshaus Favoriten' },
  { id: 'b', name: 'Bürohaus Lände' },
  { id: 'c', name: 'Grinzing Villa', status: 'closed' as const },
  { id: 'm', name: 'Volksschule Mühlgasse', status: 'paused' as const },
  { id: 's', name: 'Seestadt D12' },
]

const names = (rows: { name: string }[]): string[] => rows.map((row) => row.name)

describe('switcherSheetSections', () => {
  test('recents first, in the order opened, then every other running project', () => {
    const sections = switcherSheetSections(PROJECTS, 'a', ['s', 'a'], '')
    expect(sections).toEqual({
      kind: 'browse',
      recent: [PROJECTS[4], PROJECTS[0]],
      rest: [PROJECTS[1], PROJECTS[3]],
    })
  })

  test('at most three recents, and never a closed or vanished project among them', () => {
    const sections = switcherSheetSections(PROJECTS, 'a', ['gone', 'c', 'b', 's', 'm', 'a'], '')
    if (sections.kind !== 'browse') throw new Error('expected the browse list')
    expect(names(sections.recent)).toEqual([
      'Bürohaus Lände',
      'Seestadt D12',
      'Volksschule Mühlgasse',
    ])
  })

  test('a query folds case and diacritics into one list of matches', () => {
    expect(switcherSheetSections(PROJECTS, 'a', ['s'], 'muhl')).toEqual({
      kind: 'search',
      matches: [PROJECTS[3]],
    })
    expect(switcherSheetSections(PROJECTS, 'a', [], '  BÜRO ')).toEqual({
      kind: 'search',
      matches: [PROJECTS[1]],
    })
  })

  test('the closed project stays offered only while it is the one open', () => {
    const sections = switcherSheetSections(PROJECTS, 'c', [], 'grinzing')
    expect(sections).toEqual({ kind: 'search', matches: [PROJECTS[2]] })
    expect(switcherSheetSections(PROJECTS, 'a', [], 'grinzing')).toEqual({
      kind: 'search',
      matches: [],
    })
  })
})

describe('withRecentProject', () => {
  test('moves a project to the front and keeps the list short', () => {
    expect(withRecentProject(['a', 'b', 'c'], 'c')).toEqual(['c', 'a', 'b'])
    expect(withRecentProject(['1', '2', '3', '4', '5', '6', '7', '8'], '9')).toHaveLength(8)
  })
})

describe('ProjectSwitcherSheet', () => {
  beforeEach(() => {
    window.localStorage.setItem(RECENT_PROJECTS_STORAGE_KEY, JSON.stringify(['b', 'a']))
  })
  afterEach(() => {
    window.localStorage.removeItem(RECENT_PROJECTS_STORAGE_KEY)
    useShellOverlays.setState({ projectSheetOpen: false })
    push.mockClear()
  })

  const open = async (): Promise<HTMLElement> => {
    render(<ProjectSwitcherSheet projects={PROJECTS} activeProjectId="a" />)
    act(() => useShellOverlays.getState().setProjectSheetOpen(true))
    return screen.findByRole('dialog', { name: 'Switch project' })
  }

  test('opens from the shell store with the recents on top and 56px rows', async () => {
    const sheet = await open()
    const recent = within(sheet).getByRole('region', { name: 'Recently opened' })
    const rows = within(recent).getAllByRole('button')
    expect(rows.map((row) => row.textContent)).toEqual(['Bürohaus Lände', 'Amtshaus Favoriten'])
    expect(rows[1]).toHaveAttribute('aria-current', 'true')
    for (const row of rows) expect(row.className).toContain('min-h-14')
    expect(within(sheet).getByRole('link', { name: 'View all projects' })).toHaveAttribute(
      'href',
      '/app/projects'
    )
  })

  test('does not raise the keyboard on open: the field waits for a tap', async () => {
    const sheet = await open()
    expect(within(sheet).getByRole('searchbox', { name: 'Search projects' })).not.toHaveFocus()
  })

  test('choosing a project goes to its chat and closes the sheet', async () => {
    const user = userEvent.setup()
    const sheet = await open()
    await user.click(within(sheet).getByRole('button', { name: 'Bürohaus Lände' }))
    expect(push).toHaveBeenCalledWith('/app/projects/b/chat')
    expect(useShellOverlays.getState().projectSheetOpen).toBe(false)
  })

  test('choosing the project already open only closes the sheet', async () => {
    const user = userEvent.setup()
    const sheet = await open()
    await user.click(within(sheet).getByRole('button', { name: 'Amtshaus Favoriten' }))
    expect(push).not.toHaveBeenCalled()
  })

  test('typing narrows to matches, and says so when nothing matches', async () => {
    const user = userEvent.setup()
    const sheet = await open()
    const field = within(sheet).getByRole('searchbox', { name: 'Search projects' })
    await user.type(field, 'seestadt')
    expect(
      within(within(sheet).getByRole('list', { name: 'Matching projects' })).getAllByRole('button')
    ).toHaveLength(1)
    await user.clear(field)
    await user.type(field, 'zzz')
    expect(within(sheet).getByText('No running project has that name.')).toBeInTheDocument()
  })
})
