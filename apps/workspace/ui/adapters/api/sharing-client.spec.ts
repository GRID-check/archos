/**
 * @vitest-environment node
 *
 * The URLs, methods and bodies the sharing client puts on the wire, and the
 * refusal envelope it carries back. The share dialog says WHY a change was
 * refused (the reason, the person, the restricted folders), so those details
 * must survive the trip; a body that is not an envelope still refuses, with no
 * detail to show.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { ApiRequestError } from './api-error'
import {
  changeResourceRole,
  escalateResourceAccess,
  getResourceSharing,
  getShareCandidates,
  grantResourceAccess,
  revokeResourceAccess,
  setResourceVisibility,
  SharingRequestError,
} from './sharing-client'

const fetchMock = vi.fn()

beforeEach(() => {
  fetchMock.mockReset()
  vi.stubGlobal('fetch', fetchMock)
})

afterEach(() => {
  vi.unstubAllGlobals()
})

const JSON_HEADERS = { 'Content-Type': 'application/json' }

describe('reads', () => {
  it('reads the roster from the resource route, with both ids encoded', async () => {
    fetchMock.mockResolvedValueOnce(Response.json({ visibility: 'private', grants: [] }))

    await getResourceSharing('conversation', 'a/b')

    expect(fetchMock).toHaveBeenCalledWith('/api/sharing/conversation/a%2Fb')
  })

  it('reads the invite candidates from the candidates route', async () => {
    fetchMock.mockResolvedValueOnce(Response.json([]))

    await getShareCandidates('conversation', 'c-1')

    expect(fetchMock).toHaveBeenCalledWith('/api/sharing/conversation/c-1/candidates')
  })

  it('throws the typed error with the status when a read fails', async () => {
    fetchMock.mockResolvedValueOnce(new Response('nope', { status: 502 }))

    const failure = await getResourceSharing('conversation', 'c-1').catch((error: unknown) => error)

    expect(failure).toBeInstanceOf(ApiRequestError)
    expect(failure).toMatchObject({ status: 502 })
  })
})

describe('changes', () => {
  it('sets the visibility with a PATCH to the resource', async () => {
    fetchMock.mockResolvedValueOnce(Response.json({}))

    await setResourceVisibility('conversation', 'c-1', 'organization')

    expect(fetchMock).toHaveBeenCalledWith('/api/sharing/conversation/c-1', {
      method: 'PATCH',
      headers: JSON_HEADERS,
      body: JSON.stringify({ visibility: 'organization' }),
    })
  })

  it('grants access with a POST to the grants route', async () => {
    fetchMock.mockResolvedValueOnce(Response.json({}))

    await grantResourceAccess('conversation', 'c-1', 'user-2', 'collaborator')

    expect(fetchMock).toHaveBeenCalledWith('/api/sharing/conversation/c-1/grants', {
      method: 'POST',
      headers: JSON_HEADERS,
      body: JSON.stringify({ subjectUserId: 'user-2', role: 'collaborator' }),
    })
  })

  it('changes a role with a PATCH to the grants route', async () => {
    fetchMock.mockResolvedValueOnce(Response.json({}))

    await changeResourceRole('conversation', 'c-1', 'user-2', 'owner')

    expect(fetchMock).toHaveBeenCalledWith('/api/sharing/conversation/c-1/grants', {
      method: 'PATCH',
      headers: JSON_HEADERS,
      body: JSON.stringify({ subjectUserId: 'user-2', role: 'owner' }),
    })
  })

  it('revokes access with a DELETE to the one grant', async () => {
    fetchMock.mockResolvedValueOnce(Response.json({}))

    await revokeResourceAccess('conversation', 'c-1', 'user 2')

    expect(fetchMock).toHaveBeenCalledWith('/api/sharing/conversation/c-1/grants/user%202', { method: 'DELETE' })
  })

  it('escalates with a POST of the escalate flag to the grants route', async () => {
    fetchMock.mockResolvedValueOnce(Response.json({}))

    await escalateResourceAccess('conversation', 'c-1')

    expect(fetchMock).toHaveBeenCalledWith('/api/sharing/conversation/c-1/grants', {
      method: 'POST',
      headers: JSON_HEADERS,
      body: JSON.stringify({ escalate: true }),
    })
  })

  it('answers the roster the server returned, never a guess', async () => {
    const roster = { visibility: 'private', grants: [{ subjectUserId: 'user-2' }] }
    fetchMock.mockResolvedValueOnce(Response.json(roster))

    await expect(grantResourceAccess('conversation', 'c-1', 'user-2', 'collaborator')).resolves.toEqual(roster)
  })

  it('surfaces a refusal with the envelope details the dialog shows', async () => {
    fetchMock.mockResolvedValueOnce(
      Response.json(
        { error: 'Nope', details: { reason: 'restricted-content', person: 'Anna', folders: ['Akten', 7] } },
        { status: 403 },
      ),
    )

    const failure = await revokeResourceAccess('conversation', 'c-1', 'user-2').catch((error: unknown) => error)

    expect(failure).toBeInstanceOf(SharingRequestError)
    expect(failure).toMatchObject({
      status: 403,
      reason: 'restricted-content',
      failure: { reason: 'restricted-content', message: 'Nope', person: 'Anna', folders: ['Akten'] },
    })
  })

  it('refuses without detail when the refusal body is not an envelope', async () => {
    fetchMock.mockResolvedValueOnce(new Response('<html>', { status: 500 }))

    const failure = await escalateResourceAccess('conversation', 'c-1').catch((error: unknown) => error)

    expect(failure).toMatchObject({
      status: 500,
      reason: null,
      failure: { reason: null, message: null },
    })
  })
})
