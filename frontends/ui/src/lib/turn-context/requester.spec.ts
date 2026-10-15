/**
 * @vitest-environment node
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const getUser = vi.fn()
vi.mock('server-only', () => ({}))
vi.mock('@/lib/workos/client', () => ({ getWorkOS: () => ({ userManagement: { getUser } }) }))
vi.mock('@/lib/cache', () => ({
  getCached: vi.fn(async (_key: string, _ttl: number, load: () => Promise<unknown>) => load()),
}))

import { getCached } from '@/lib/cache'
import { loadRequester } from './requester'

beforeEach(() => {
  vi.clearAllMocks()
})

describe('loadRequester', () => {
  it('reads first name, last name and email from WorkOS, keyed by organization and user', async () => {
    getUser.mockResolvedValueOnce({ firstName: ' Anna ', lastName: 'Weber', email: 'anna@example.at' })
    expect(await loadRequester('org_1', 'user_1')).toEqual({
      firstName: 'Anna', lastName: 'Weber', email: 'anna@example.at',
    })
    expect(getUser).toHaveBeenCalledWith('user_1')
    expect(vi.mocked(getCached).mock.calls[0][0]).toBe('requester:org_1:user_1')
  })

  it('reads an empty name as absent rather than as a name', async () => {
    getUser.mockResolvedValueOnce({ firstName: '', lastName: null, email: 'anna@example.at' })
    expect(await loadRequester('org_1', 'user_1')).toEqual({ firstName: null, lastName: null, email: 'anna@example.at' })
  })

  it('answers null when WorkOS fails, so the turn goes on without the name', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    getUser.mockRejectedValueOnce(new Error('workos down'))
    expect(await loadRequester('org_1', 'user_1')).toBeNull()
    warn.mockRestore()
  })
})
