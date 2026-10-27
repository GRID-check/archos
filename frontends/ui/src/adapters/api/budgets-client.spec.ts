/**
 * @vitest-environment node
 *
 * The method, path and body the budgets client puts on the wire, and the status
 * it surfaces. The limit editor branches on that status (a 422 is a rejected
 * limit, anything else a failed save), so the status must reach the caller intact.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { ApiRequestError } from './api-error'
import { removeBudgetPolicy, setBudgetPolicy } from './budgets-client'

const fetchMock = vi.fn()

beforeEach(() => {
  fetchMock.mockReset()
  vi.stubGlobal('fetch', fetchMock)
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('setBudgetPolicy', () => {
  it('PUTs the limits as JSON to the budgets route', async () => {
    fetchMock.mockResolvedValueOnce(Response.json({ policy: {} }, { status: 201 }))

    await setBudgetPolicy({
      scope: 'member',
      subjectId: 'user-1',
      dailyLimit: 5,
      monthlyLimit: null,
    })

    expect(fetchMock).toHaveBeenCalledWith('/api/organization/budgets', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ scope: 'member', subjectId: 'user-1', dailyLimit: 5, monthlyLimit: null }),
    })
  })

  it('surfaces a rejected limit with its 422 status', async () => {
    fetchMock.mockResolvedValueOnce(new Response('bad', { status: 422 }))

    const failure = await setBudgetPolicy({
      scope: 'project',
      subjectId: 'p-1',
      dailyLimit: -1,
      monthlyLimit: null,
    }).catch((error: unknown) => error)

    expect(failure).toBeInstanceOf(ApiRequestError)
    expect(failure).toMatchObject({ status: 422 })
  })
})

describe('removeBudgetPolicy', () => {
  it('DELETEs the subject to the budgets route', async () => {
    fetchMock.mockResolvedValueOnce(Response.json({ removed: true }))

    await removeBudgetPolicy({ scope: 'project', subjectId: 'p-1' })

    expect(fetchMock).toHaveBeenCalledWith('/api/organization/budgets', {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ scope: 'project', subjectId: 'p-1' }),
    })
  })

  it('surfaces a failed removal with its status', async () => {
    fetchMock.mockResolvedValueOnce(new Response('nope', { status: 403 }))

    const failure = await removeBudgetPolicy({ scope: 'member', subjectId: 'u' }).catch(
      (error: unknown) => error,
    )

    expect(failure).toMatchObject({ status: 403 })
  })
})
