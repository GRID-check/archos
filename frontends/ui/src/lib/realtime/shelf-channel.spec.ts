/**
 * @vitest-environment node
 */
/**
 * A shelf as a live channel (`shelf:project-<id>`, `shelf:archiv`): who may be
 * in it (whoever may read the shelf), which tenant's topic it listens to, and
 * that a change published by a writer reaches a listener of that topic.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('server-only', () => ({}))
vi.mock('@/lib/documents/shelf-authz', () => ({ requireShelfRead: vi.fn() }))
vi.mock('@/lib/proposals/service', () => ({ requireReadableProposal: vi.fn() }))
vi.mock('@/lib/documents/access', () => ({ getAccessibleDocument: vi.fn() }))
vi.mock('@/lib/sharing/directory', () => ({ loadOrganizationDirectory: vi.fn() }))

import { ForbiddenError } from '@/lib/api/errors'
import type { AuthorizedSession } from '@/lib/auth/types'
import { requireShelfRead } from '@/lib/documents/shelf-authz'
import { publishShelfChanged } from '@/lib/documents/shelf-live'
import { shelfChannelKey, shelfTopic } from '@/lib/documents/shelf-live-events'
import { __setHubTransportForTests, subscribe } from './hub'
import { CHANNELS, resolveChannel } from './registry'
import { shelfChannel } from './shelf-channel'

const SESSION = { userId: 'user_1', organizationId: 'org_1' } as Partial<AuthorizedSession> as AuthorizedSession
const PROJECT = '0b7c8f5e-1d1e-4c39-9d2c-3f0f6c1a2b3c'

beforeEach(async () => {
  vi.clearAllMocks()
  await __setHubTransportForTests(null)
})

describe('the shelf channel', () => {
  it('is registered, and both shelves’ keys resolve to it', () => {
    expect(CHANNELS.shelf).toBe(shelfChannel)
    expect(resolveChannel(shelfChannelKey({ kind: 'project', projectId: PROJECT }))).toMatchObject({
      params: { kind: 'project', projectId: PROJECT },
    })
    expect(resolveChannel(shelfChannelKey({ kind: 'archiv' }))).toMatchObject({ params: { kind: 'archiv' } })
  })

  it('refuses a key that names no shelf', () => {
    expect(shelfChannel.parse('session')).toBeNull()
    expect(shelfChannel.parse('project-')).toBeNull()
    expect(shelfChannel.parse(PROJECT)).toBeNull()
  })

  it('lets a reader in exactly when they may read the shelf', async () => {
    const shelf = { kind: 'project', projectId: PROJECT } as const
    vi.mocked(requireShelfRead).mockResolvedValueOnce(undefined)
    await expect(shelfChannel.authorize(SESSION, shelf)).resolves.toBeUndefined()
    expect(requireShelfRead).toHaveBeenCalledWith(SESSION, shelf)

    vi.mocked(requireShelfRead).mockRejectedValueOnce(new ForbiddenError())
    await expect(shelfChannel.authorize(SESSION, shelf)).rejects.toBeInstanceOf(ForbiddenError)
  })

  it('listens to the session’s own Archiv, never another tenant’s', () => {
    expect(shelfChannel.topics({ kind: 'archiv' }, 'org_1')).toEqual(['rt:shelf:org_1:archiv'])
    expect(shelfChannel.topics({ kind: 'archiv' }, 'org_2')).toEqual(['rt:shelf:org_2:archiv'])
  })

  it('takes nothing from a browser, and re-checks an open stream', () => {
    expect(shelfChannel.upstream).toBeUndefined()
    expect(shelfChannel.reauthorizeMs).toBeGreaterThan(0)
    expect(shelfChannel.reauthorizeMs).toBeLessThanOrEqual(60_000)
  })
})

describe('publishShelfChanged', () => {
  it('reaches a listener of the shelf’s topic with an event the channel accepts', async () => {
    const shelf = { kind: 'project', projectId: PROJECT } as const
    const heard: unknown[] = []
    const release = subscribe(shelfChannel.topics(shelf, 'org_1')[0], (payload) => heard.push(payload))

    await publishShelfChanged('org_1', shelf, { folders: true })
    await publishShelfChanged('org_1', shelf)
    // Another tenant's change to a shelf with the same name is not heard.
    await publishShelfChanged('org_2', shelf)
    release()

    expect(heard).toEqual([
      { kind: 'shelf.changed', folders: true },
      { kind: 'shelf.changed', folders: false },
    ])
    expect(shelfChannel.events.safeParse(heard[0]).success).toBe(true)
    expect(shelfTopic('org_1', shelf)).toBe(`rt:shelf:org_1:project:${PROJECT}`)
  })

  it('says nothing for a row on no shelf (a chat attachment)', async () => {
    const heard: unknown[] = []
    const release = subscribe(shelfTopic('org_1', { kind: 'archiv' }), (payload) => heard.push(payload))
    await publishShelfChanged('org_1', null)
    release()
    expect(heard).toEqual([])
  })
})
