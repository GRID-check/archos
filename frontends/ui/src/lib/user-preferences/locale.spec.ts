/**
 * @vitest-environment node
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('server-only', () => ({}))

const withAuth = vi.fn()
vi.mock('@workos-inc/authkit-nextjs', () => ({ withAuth: () => withAuth() }))

const findUserPreferences = vi.fn()
vi.mock('./repository', () => ({ findUserPreferences: (...args: unknown[]) => findUserPreferences(...args) }))

const findOrganization = vi.fn()
vi.mock('@/lib/organizations/repository', () => ({
  findOrganization: (...args: unknown[]) => findOrganization(...args),
}))

const { findSavedLocale } = await import('./locale')

beforeEach(() => {
  vi.clearAllMocks()
  withAuth.mockResolvedValue({ user: { id: 'user_1' }, organizationId: 'org_1' })
  findUserPreferences.mockResolvedValue(null)
  findOrganization.mockResolvedValue(null)
})

describe('findSavedLocale', () => {
  it('reads the person’s own choice first', async () => {
    findUserPreferences.mockResolvedValue({ locale: 'de' })
    findOrganization.mockResolvedValue({ defaultLocale: 'en' })
    await expect(findSavedLocale()).resolves.toEqual({ known: true, locale: 'de' })
    expect(findUserPreferences).toHaveBeenCalledWith('user_1', 'org_1')
  })

  it('falls back to the office’s chosen default', async () => {
    findOrganization.mockResolvedValue({ defaultLocale: 'de' })
    await expect(findSavedLocale()).resolves.toEqual({ known: true, locale: 'de' })
  })

  it('says nothing was chosen when the office never picked one (NULL since 0155)', async () => {
    findOrganization.mockResolvedValue({ defaultLocale: null })
    await expect(findSavedLocale()).resolves.toEqual({ known: true, locale: null })
  })

  it('is unknown when no one is signed in, or when it cannot ask', async () => {
    withAuth.mockResolvedValueOnce({ user: null })
    await expect(findSavedLocale()).resolves.toEqual({ known: false })
    withAuth.mockRejectedValueOnce(new Error('not covered by the AuthKit proxy'))
    await expect(findSavedLocale()).resolves.toEqual({ known: false })
    findUserPreferences.mockRejectedValueOnce(new Error('database down'))
    await expect(findSavedLocale()).resolves.toEqual({ known: false })
  })
})
