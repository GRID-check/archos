import { render, screen, within } from '@/test-utils'
import userEvent from '@testing-library/user-event'
import { describe, expect, test, vi } from 'vitest'
import { DEFAULT_PUSH_PREFERENCES } from '@/lib/inbox/push-categories'
import { FIXTURE_DEVICES, pushFixture } from './fixtures'
import { NotificationSettingsView } from './notification-settings'
import { PRODUCT_NAME } from '@/lib/brand'

describe('NotificationSettingsView', () => {
  test('draws nothing where the deployment sends no notifications', () => {
    const { container } = render(<NotificationSettingsView push={pushFixture({ phase: 'off' })} />)
    expect(container).toBeEmptyDOMElement()
  })

  test('says what is happening while it reads', () => {
    render(<NotificationSettingsView push={pushFixture({ phase: 'loading' })} />)
    expect(screen.getByText('Notifications')).toBeInTheDocument()
    expect(screen.queryByRole('switch')).not.toBeInTheDocument()
  })

  test.each([
    ['unsupported', 'This browser cannot show notifications'],
    ['needs-install', `Add ${PRODUCT_NAME} to your Home Screen first`],
    ['denied', `Notifications are blocked for ${PRODUCT_NAME}`],
  ] as const)('explains %s instead of offering a switch that does nothing', (phase, title) => {
    render(<NotificationSettingsView push={pushFixture({ phase })} />)
    expect(screen.getByText(title)).toBeInTheDocument()
    expect(screen.queryByRole('switch', { name: 'Notify me on this device' })).not.toBeInTheDocument()
  })

  test('tells an iPhone how to install and a blocked browser how to allow', () => {
    const { rerender } = render(<NotificationSettingsView push={pushFixture({ phase: 'needs-install' })} />)
    expect(screen.getByText(/Add to Home Screen/)).toBeInTheDocument()
    rerender(<NotificationSettingsView push={pushFixture({ phase: 'denied' })} />)
    expect(screen.getByText(/set Notifications to Allow and reload/)).toBeInTheDocument()
  })

  test('turns this device on from the switch, and off again', async () => {
    const enable = vi.fn(async () => undefined)
    const disable = vi.fn(async () => undefined)
    const { rerender } = render(<NotificationSettingsView push={pushFixture({ enable, disable })} />)
    const toggle = screen.getByRole('switch', { name: 'Notify me on this device' })
    expect(toggle).not.toBeChecked()
    await userEvent.click(toggle)
    expect(enable).toHaveBeenCalledTimes(1)

    rerender(
      <NotificationSettingsView
        push={pushFixture({ enable, disable, thisDeviceOn: true, thisDeviceId: 'd-iphone', devices: FIXTURE_DEVICES })}
      />
    )
    expect(screen.getByRole('switch', { name: 'Notify me on this device' })).toBeChecked()
    await userEvent.click(screen.getByRole('switch', { name: 'Notify me on this device' }))
    expect(disable).toHaveBeenCalledTimes(1)
  })

  test('lists the devices, marks this one, and removes one by its id', async () => {
    const removeDevice = vi.fn(async () => undefined)
    render(
      <NotificationSettingsView
        push={pushFixture({ devices: FIXTURE_DEVICES, thisDeviceOn: true, thisDeviceId: 'd-iphone', removeDevice })}
      />
    )
    const rows = screen.getAllByRole('listitem')
    expect(rows).toHaveLength(3)
    expect(within(rows[0]!).getByText('This device')).toBeInTheDocument()
    expect(within(rows[2]!).getByText('Nothing delivered yet')).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'Remove Chrome auf Windows' }))
    expect(removeDevice).toHaveBeenCalledWith('d-laptop')
  })

  test('shows the empty list and no choices before any device exists', () => {
    render(<NotificationSettingsView push={pushFixture()} />)
    expect(screen.getByText('No device receives notifications yet.')).toBeInTheDocument()
    expect(screen.queryByText(`What ${PRODUCT_NAME} notifies you about`)).not.toBeInTheDocument()
  })

  test('changes a category and the lock-screen preview through the preferences', async () => {
    const updatePreferences = vi.fn(async () => undefined)
    render(
      <NotificationSettingsView
        push={pushFixture({ devices: FIXTURE_DEVICES, thisDeviceOn: true, thisDeviceId: 'd-iphone', updatePreferences })}
      />
    )
    expect(screen.getByRole('switch', { name: 'Requests to you' })).toBeChecked()
    expect(screen.getByRole('switch', { name: 'Activity' })).not.toBeChecked()
    await userEvent.click(screen.getByRole('switch', { name: 'Activity' }))
    expect(updatePreferences).toHaveBeenLastCalledWith({ categories: { activity: true } })
    await userEvent.click(screen.getByRole('switch', { name: 'Show content on the lock screen' }))
    expect(updatePreferences).toHaveBeenLastCalledWith({ showContent: false })
  })

  test('reflects stored choices', () => {
    render(
      <NotificationSettingsView
        push={pushFixture({
          devices: FIXTURE_DEVICES,
          preferences: { showContent: false, categories: { ...DEFAULT_PUSH_PREFERENCES.categories, requests: false } },
        })}
      />
    )
    expect(screen.getByRole('switch', { name: 'Requests to you' })).not.toBeChecked()
    expect(screen.getByRole('switch', { name: 'Show content on the lock screen' })).not.toBeChecked()
  })

  test('says so when an action failed', () => {
    render(<NotificationSettingsView push={pushFixture({ error: 'enable' })} />)
    expect(screen.getByRole('alert')).toHaveTextContent('could not be turned on')
  })

  test('holds the controls while an action is running', () => {
    render(<NotificationSettingsView push={pushFixture({ busy: true, devices: FIXTURE_DEVICES })} />)
    expect(screen.getByRole('switch', { name: 'Notify me on this device' })).toBeDisabled()
    expect(screen.getByRole('switch', { name: 'Activity' })).toBeDisabled()
  })
})
