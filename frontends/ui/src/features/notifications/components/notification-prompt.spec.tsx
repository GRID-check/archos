import { render, screen } from '@/test-utils'
import userEvent from '@testing-library/user-event'
import { describe, expect, test, vi } from 'vitest'
import { pushFixture } from './fixtures'
import { NotificationPromptView, promptIsDue } from './notification-prompt'

describe('when the inbox offers notifications', () => {
  test.each([
    ['ready, not on, not dismissed', { phase: 'ready', thisDeviceOn: false }, false, true],
    ['already on for this device', { phase: 'ready', thisDeviceOn: true }, false, false],
    ['dismissed', { phase: 'ready', thisDeviceOn: false }, true, false],
    ['blocked in the browser', { phase: 'denied', thisDeviceOn: false }, false, false],
    ['an iPhone outside the Home Screen', { phase: 'needs-install', thisDeviceOn: false }, false, false],
    ['a browser that cannot', { phase: 'unsupported', thisDeviceOn: false }, false, false],
    ['the deployment sends none', { phase: 'off', thisDeviceOn: false }, false, false],
    ['still reading', { phase: 'loading', thisDeviceOn: false }, false, false],
  ] as const)('%s -> %s', (_label, state, dismissed, due) => {
    expect(promptIsDue(state, dismissed)).toBe(due)
  })
})

describe('NotificationPromptView', () => {
  test('offers, and turns on only from the button', async () => {
    const enable = vi.fn(async () => undefined)
    render(<NotificationPromptView push={pushFixture({ enable })} dismissed={false} onDismiss={() => undefined} />)
    expect(enable).not.toHaveBeenCalled()
    expect(screen.getByText('Get notified when something arrives?')).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'Turn on' }))
    expect(enable).toHaveBeenCalledTimes(1)
  })

  test('can be dismissed from either control', async () => {
    const onDismiss = vi.fn()
    render(<NotificationPromptView push={pushFixture()} dismissed={false} onDismiss={onDismiss} />)
    await userEvent.click(screen.getByRole('button', { name: 'Not now' }))
    await userEvent.click(screen.getByRole('button', { name: 'Dismiss the notification suggestion' }))
    expect(onDismiss).toHaveBeenCalledTimes(2)
  })

  test('draws nothing when it is not due', () => {
    const { container } = render(
      <NotificationPromptView push={pushFixture({ thisDeviceOn: true })} dismissed={false} onDismiss={() => undefined} />
    )
    expect(container).toBeEmptyDOMElement()
  })
})
