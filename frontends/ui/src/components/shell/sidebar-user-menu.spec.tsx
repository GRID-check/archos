/**
 * The avatar menu offers „Switch organization" only to someone who works in
 * more than one office.
 */
import { describe, expect, test, vi } from 'vitest'
import { render, screen } from '@/test-utils'
import userEvent from '@testing-library/user-event'

vi.mock('@workos-inc/authkit-nextjs/components', () => ({ useAuth: () => ({ switchToOrganization: vi.fn() }) }))
vi.mock('@/adapters/auth/use-auth', () => ({ useAuth: () => ({ user: null, signOut: vi.fn() }) }))
vi.mock('@/features/onboarding/components/product-tour', () => ({ useStartProductTour: () => vi.fn() }))
vi.mock('@/features/product-feedback/components', () => ({
  useFeedbackAvailable: () => false,
  useFeedbackUpdatedCount: () => 0,
  useOpenFeedbackThreads: () => vi.fn(),
}))

import { SidebarUserMenu } from './sidebar-user-menu'

async function openMenu(organizations: { id: string; name: string; current: boolean }[]) {
  render(<SidebarUserMenu authRequired user={{ name: 'Anna Berger' }} organizations={organizations} />)
  await userEvent.click(screen.getByRole('button'))
  await screen.findByRole('menu')
}

describe('SidebarUserMenu', () => {
  test('offers the switch to someone in several organizations', async () => {
    await openMenu([
      { id: 'org_1', name: 'GRID Test', current: true },
      { id: 'org_2', name: 'feld72 Architekten', current: false },
    ])

    expect(screen.getByTestId('user-menu-switch-organization')).toBeInTheDocument()
  })

  test('offers nothing to someone in one organization', async () => {
    await openMenu([])

    expect(screen.queryByTestId('user-menu-switch-organization')).not.toBeInTheDocument()
  })
})
