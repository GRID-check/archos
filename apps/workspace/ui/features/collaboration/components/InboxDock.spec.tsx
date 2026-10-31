import type { ReactNode } from 'react'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { act, fireEvent, render, screen } from '@/test-utils'

vi.mock('./InboxQueue', () => ({ InboxQueue: () => <p>queue</p> }))
vi.mock('next/link', () => ({
  default: ({ href, children, ...rest }: { href: string; children: ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}))

import { useStartDock } from '@/components/shell/start-dock'
import { InboxDock } from './InboxDock'

/** The door the dock was opened from: any focusable element carrying `data-dock-door`, as the header's bell does. */
const Door = () => (
  <button type="button" data-dock-door="inbox" data-testid="door">
    Postfach
  </button>
)

afterEach(() => act(() => useStartDock.getState().close()))

describe('InboxDock — a disclosure the reader opened', () => {
  test('opened by the reader, it takes the focus so its keys work at once', () => {
    act(() => useStartDock.getState().open('inbox'))
    render(<InboxDock />)
    expect(screen.getByTestId('inbox-dock')).toHaveFocus()
    // Taken once: a later render does not pull the focus back from the page.
    expect(useStartDock.getState().takesFocus).toBe(false)
  })

  test('restored after a reload, it leaves the focus where the page has it', () => {
    window.sessionStorage.setItem('startDock.panel', 'inbox')
    act(() => useStartDock.getState().restore())
    render(<InboxDock />)
    expect(screen.getByTestId('inbox-dock')).not.toHaveFocus()
  })

  test('Escape puts it away and hands the focus back to its door', () => {
    act(() => useStartDock.getState().open('inbox'))
    render(
      <>
        <Door />
        <InboxDock />
      </>,
    )
    fireEvent.keyDown(screen.getByTestId('inbox-dock'), { key: 'Escape' })
    expect(useStartDock.getState().panel).toBeNull()
    expect(screen.getByTestId('door')).toHaveFocus()
  })
})
