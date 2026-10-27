/**
 * The thread's browser door: each call reaches its route with its method and
 * body, and a refusal arrives with the server's code and details.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { ApiRequestError } from './api-error'
import { detachMailThreadEntry, followMailThread, mailThreadEntryOriginalUrl, unfollowMailThread } from './mail-thread-client'

const answer = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

afterEach(() => vi.unstubAllGlobals())

describe('mail-thread-client', () => {
  it('follows with the body, and an empty one for the default days', async () => {
    const fetch = vi.fn().mockImplementation(async () => answer(200, { follow: { id: 'f' }, renewed: false }))
    vi.stubGlobal('fetch', fetch)
    await followMailThread('p/1', 't', { days: 30 })
    expect(fetch).toHaveBeenCalledWith('/api/projects/p%2F1/mail-threads/t/follow', expect.objectContaining({ method: 'POST', body: '{"days":30}' }))
    await followMailThread('p', 't')
    expect(fetch.mock.calls[1][1]).toMatchObject({ body: '{}' })
  })

  it('ends the caller’s follow, or someone else’s by user id', async () => {
    const fetch = vi.fn().mockImplementation(async () => answer(200, { endedFollowId: null }))
    vi.stubGlobal('fetch', fetch)
    await unfollowMailThread('p', 't')
    await unfollowMailThread('p', 't', { userId: 'user_1' })
    expect(fetch.mock.calls.map((call) => [call[0], call[1].method])).toEqual([
      ['/api/projects/p/mail-threads/t/follow', 'DELETE'],
      ['/api/projects/p/mail-threads/t/follow?userId=user_1', 'DELETE'],
    ])
  })

  it('detaches with the target, and a refusal carries its code and details', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(answer(409, { error: 'refused', details: { reason: 'upload_refused', failure: 'quota' } })))
    const refused = await detachMailThreadEntry('p', 't', 'e', { target: { action: 'create', name: 'X' } }).catch((error: unknown) => error)
    expect(refused).toBeInstanceOf(ApiRequestError)
    expect(refused).toMatchObject({ status: 409, reason: 'upload_refused', details: { reason: 'upload_refused', failure: 'quota' } })
  })

  it('builds the original’s link, never fetching it', () => {
    expect(mailThreadEntryOriginalUrl('p', 't', 'e')).toBe('/api/projects/p/mail-threads/t/entries/e/original')
  })
})
