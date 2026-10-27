/**
 * The header's organization switcher: WorkOS's widget, AuthKit's switch, and
 * what happens after it.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { render, screen } from '@/test-utils'
import userEvent from '@testing-library/user-event'

const switchToOrganization = vi.fn()
vi.mock('@workos-inc/authkit-nextjs/components', () => ({ useAuth: () => ({ switchToOrganization }) }))
vi.mock('@radix-ui/themes/styles.css', () => ({}))
// The widget needs a live token; this stands in for it picking an organization.
vi.mock('@workos-inc/widgets', () => ({
  WorkOsWidgets: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  OrganizationSwitcher: ({ switchToOrganization: pick }: { switchToOrganization: (args: { organizationId: string }) => Promise<void> }) => (
    <button type="button" onClick={() => pick({ organizationId: 'org_2' }).catch((error: unknown) => picked.reject(error))}>
      pick
    </button>
  ),
}))
vi.mock('@/lib/workos/use-widget-appearance', () => ({ useResolvedAppearance: () => 'light', widgetTheme: () => undefined }))

const picked = { reject: vi.fn() }
const assign = vi.fn()

import { HeaderOrganizationSwitcher } from './organization-switcher'

beforeEach(() => {
  vi.stubGlobal('location', { ...window.location, assign })
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.clearAllMocks()
})

describe('HeaderOrganizationSwitcher', () => {
  test('switches the session, then loads the new office’s projects', async () => {
    switchToOrganization.mockResolvedValue({})
    render(<HeaderOrganizationSwitcher />)

    await userEvent.click(screen.getByRole('button', { name: 'pick' }))

    expect(switchToOrganization).toHaveBeenCalledWith('org_2')
    expect(assign).toHaveBeenCalledWith('/app/projects')
  })

  test('leaves an SSO or MFA sign-in to the redirect Next is already following', async () => {
    switchToOrganization.mockRejectedValue(Object.assign(new Error('NEXT_REDIRECT'), { digest: 'NEXT_REDIRECT;push;https://auth.workos.com/sso;307;' }))
    render(<HeaderOrganizationSwitcher />)

    await userEvent.click(screen.getByRole('button', { name: 'pick' }))

    expect(assign).not.toHaveBeenCalled()
    expect(picked.reject).not.toHaveBeenCalled()
  })

  test('hands any other failure back to the widget', async () => {
    switchToOrganization.mockRejectedValue(new Error('refresh failed'))
    render(<HeaderOrganizationSwitcher />)

    await userEvent.click(screen.getByRole('button', { name: 'pick' }))

    expect(assign).not.toHaveBeenCalled()
    expect(picked.reject).toHaveBeenCalledWith(expect.objectContaining({ message: 'refresh failed' }))
  })
})
