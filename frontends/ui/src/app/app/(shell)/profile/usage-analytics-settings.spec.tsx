import { render, screen } from '@/test-utils'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, test, vi } from 'vitest'
import { UsageAnalyticsSettings } from './usage-analytics-settings'
import { isPosthogOptedOut, optInPosthog, optOutPosthog } from '@/lib/analytics/posthog'

vi.mock('@/lib/analytics/posthog', () => ({
  isPosthogOptedOut: vi.fn(() => false),
  optInPosthog: vi.fn(),
  optOutPosthog: vi.fn(),
}))

const TOGGLE = { name: 'Share usage analytics' }

describe('UsageAnalyticsSettings', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(isPosthogOptedOut).mockReturnValue(false)
  })

  test('renders nothing where the deployment collects no analytics', () => {
    const { container } = render(<UsageAnalyticsSettings available={false} />)
    expect(container).toBeEmptyDOMElement()
  })

  test('is on by default', () => {
    render(<UsageAnalyticsSettings available />)
    expect(screen.getByRole('switch', TOGGLE)).toBeChecked()
  })

  test('turning it off opts this browser out of capturing', async () => {
    render(<UsageAnalyticsSettings available />)

    await userEvent.click(screen.getByRole('switch', TOGGLE))

    expect(optOutPosthog).toHaveBeenCalledTimes(1)
    expect(optInPosthog).not.toHaveBeenCalled()
    expect(screen.getByRole('switch', TOGGLE)).not.toBeChecked()
  })

  test('shows a stored opt-out and can opt back in', async () => {
    vi.mocked(isPosthogOptedOut).mockReturnValue(true)
    render(<UsageAnalyticsSettings available />)

    const toggle = screen.getByRole('switch', TOGGLE)
    expect(toggle).not.toBeChecked()

    await userEvent.click(toggle)

    expect(optInPosthog).toHaveBeenCalledTimes(1)
    expect(toggle).toBeChecked()
  })
})
