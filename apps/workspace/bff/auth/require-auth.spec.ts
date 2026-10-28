/**
 * @vitest-environment node
 */
import { describe, expect, it, vi, beforeEach } from 'vitest'

import { isAuthzRefusal, NoOrganizationError, SessionRequiredError } from '@/lib/api/errors'

class RedirectError extends Error {
  constructor(public url: string) {
    super(`NEXT_REDIRECT:${url}`)
    this.name = 'RedirectError'
  }
}

vi.mock('./session', () => ({
  requireGridSession: vi.fn(),
}))

vi.mock('next/navigation', () => ({
  redirect: vi.fn((url: string) => {
    throw new RedirectError(url)
  }),
}))

import { requireGridSession } from './session'
import { redirect } from 'next/navigation'
import {
  requireAuthorizedSession,
  requireAuthorizedPageSession,
} from './require-auth'
import type { AuthorizedSession, GridSession } from './types'

const authorizedSession: AuthorizedSession = {
  userId: 'user-1',
  email: 'test@grid.com',
  name: 'Test User',
  accessToken: 'token',
  organizationId: 'org-1',
  organizationMembershipId: 'mem-1',
  role: 'admin',
  permissions: [],
  featureFlags: null,
}

/** The same identity before an organization has been selected. */
const sessionWithoutOrg: GridSession = {
  ...authorizedSession,
  organizationId: null,
  organizationMembershipId: null,
}

describe('require-auth guards', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('requireAuthorizedSession throws a NoOrganizationError treated as authz error when no organization', async () => {
    vi.mocked(requireGridSession).mockResolvedValue(sessionWithoutOrg)

    let caught: unknown
    try {
      await requireAuthorizedSession()
    } catch (error) {
      caught = error
    }

    expect(caught).toBeInstanceOf(NoOrganizationError)
    expect(isAuthzRefusal(caught)).toBe(true)
    expect((caught as NoOrganizationError).status).toBe(403)
  })

  it('requireAuthorizedPageSession redirects to organization onboarding when no organization', async () => {
    vi.mocked(requireGridSession).mockResolvedValue(sessionWithoutOrg)

    await expect(requireAuthorizedPageSession()).rejects.toThrow(RedirectError)
    expect(redirect).toHaveBeenCalledWith('/app/onboarding/organization')
  })

  it('both guards resolve to the session when an organization is selected', async () => {
    vi.mocked(requireGridSession).mockResolvedValue(authorizedSession)

    await expect(requireAuthorizedSession()).resolves.toBe(authorizedSession)
    await expect(requireAuthorizedPageSession()).resolves.toBe(authorizedSession)
    expect(redirect).not.toHaveBeenCalled()
  })

  it('requireAuthorizedPageSession rethrows non-org errors without redirecting', async () => {
    vi.mocked(requireGridSession).mockRejectedValue(new SessionRequiredError())

    await expect(requireAuthorizedPageSession()).rejects.toThrow(
      'Unauthorized: Grid session required',
    )
    expect(redirect).not.toHaveBeenCalled()
  })
})
