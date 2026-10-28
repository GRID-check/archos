/**
 * @vitest-environment node
 */
/**
 * The push API (ADR-0112), driven through the TYPED CLIENT (ADR-0055): the
 * client and the routes cannot disagree about a path, a verb or a field.
 *
 * The service is real; the repository is an in-memory table that applies the
 * same scoping the SQL does (organization and person), so what these cases prove
 * is that a request can only ever reach its own person's rows.
 */

import { generateVAPIDKeys } from 'web-push'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('server-only', () => ({}))

const SESSION = vi.hoisted(() => ({
  current: {
    userId: 'user_1',
    organizationId: 'org_1',
    organizationMembershipId: 'om_1',
    email: 'anna@grid.test',
    name: 'Anna',
    role: 'member',
    permissions: [] as string[],
    accessToken: '',
    featureFlags: null,
  },
}))
vi.mock('@/lib/auth/require-auth', () => ({ requireAuthorizedSession: vi.fn(async () => SESSION.current) }))
vi.mock('@/lib/analytics/posthog-server', () => ({ captureServer: vi.fn() }))
vi.mock('@/lib/limits/enforce', async (original) => ({
  ...(await original<typeof import('@/lib/limits/enforce')>()),
  enforceLimit: vi.fn(async () => undefined),
}))

const STORE = vi.hoisted(() => ({
  rows: [] as Array<Record<string, unknown>>,
  prefs: {} as Record<string, unknown>,
  next: 0,
}))
vi.mock('@/lib/user-preferences/service', () => ({
  getUserPreferences: vi.fn(async () => STORE.prefs),
  mergeUserPreferences: vi.fn(async (_session: unknown, patch: Record<string, unknown>) => {
    STORE.prefs = { ...STORE.prefs, ...patch }
    return STORE.prefs
  }),
}))
vi.mock('@/lib/push/repository', () => {
  const mine = (org: string, user: string) => (r: Record<string, unknown>) => r.organizationId === org && r.userId === user
  return {
    MAX_DEVICES_PER_PERSON: 10,
    claimEndpoint: vi.fn(async (org: string, user: string, endpoint: string) => {
      const before = STORE.rows.length
      STORE.rows = STORE.rows.filter((r) => r.endpoint !== endpoint || mine(org, user)(r))
      return before - STORE.rows.length
    }),
    upsertSubscription: vi.fn(async (values: Record<string, unknown>) => {
      const existing = STORE.rows.find((r) => r.endpoint === values.endpoint)
      // The unique index: another person's row for the endpoint refuses the write.
      if (existing && !mine(String(values.organizationId), String(values.userId))(existing)) throw new Error('endpoint is held by another person')
      if (existing) return Object.assign(existing, values)
      const row = { id: `00000000-0000-4000-8000-${String(++STORE.next).padStart(12, '0')}`, createdAt: new Date(), lastSuccessAt: null, ...values }
      STORE.rows.push(row)
      return row
    }),
    listSubscriptions: vi.fn(async (org: string, user: string) => STORE.rows.filter(mine(org, user))),
    deleteSubscription: vi.fn(async (org: string, user: string, id: string) => {
      const before = STORE.rows.length
      STORE.rows = STORE.rows.filter((r) => !(r.id === id && mine(org, user)(r)))
      return STORE.rows.length < before
    }),
    deleteSubscriptionByEndpoint: vi.fn(async (org: string, user: string, endpoint: string) => {
      const before = STORE.rows.length
      STORE.rows = STORE.rows.filter((r) => !(r.endpoint === endpoint && mine(org, user)(r)))
      return STORE.rows.length < before
    }),
    trimSubscriptions: vi.fn(async () => 0),
  }
})

import { createPushClient, PushApiError } from '@/lib/push/client'
import { GET as config } from './config/route'
import { GET as listDevices, POST as registerDevice } from './devices/route'
import { DELETE as removeDevice } from './devices/[id]/route'
import { GET as getPreferences, PUT as putPreferences } from './preferences/route'

type Handler = (request: Request, context?: { params?: Promise<Record<string, string>> }) => Promise<Response>
const ROUTES: Array<{ pattern: RegExp; method: string; handler: Handler }> = [
  { pattern: /^\/api\/notifications\/push\/config$/, method: 'GET', handler: config },
  { pattern: /^\/api\/notifications\/push\/devices$/, method: 'GET', handler: listDevices },
  { pattern: /^\/api\/notifications\/push\/devices$/, method: 'POST', handler: registerDevice },
  { pattern: /^\/api\/notifications\/push\/devices\/([^/]+)$/, method: 'DELETE', handler: removeDevice },
  { pattern: /^\/api\/notifications\/push\/preferences$/, method: 'GET', handler: getPreferences },
  { pattern: /^\/api\/notifications\/push\/preferences$/, method: 'PUT', handler: putPreferences },
]

const client = createPushClient(async (path, init) => {
  const url = new URL(path, 'https://grid.test')
  const method = init?.method ?? 'GET'
  const route = ROUTES.find((entry) => entry.pattern.test(url.pathname) && entry.method === method)
  if (!route) throw new Error(`no route for ${method} ${url.pathname}`)
  const matched = route.pattern.exec(url.pathname) as RegExpExecArray
  return route.handler(
    new Request(url, { ...init, headers: { 'user-agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 Version/17.4 Mobile/15E148 Safari/604.1', ...(init?.headers as Record<string, string>) } }),
    { params: Promise.resolve({ id: decodeURIComponent(matched[1] ?? '') }) }
  )
})

const keys = generateVAPIDKeys()
const sub = (id: string) => ({
  endpoint: `https://fcm.googleapis.com/fcm/send/${id}`,
  keys: { p256dh: 'BKey', auth: 'secret' },
})

function as(userId: string, organizationId = 'org_1') {
  SESSION.current = { ...SESSION.current, userId, organizationId }
}

beforeEach(() => {
  STORE.rows = []
  STORE.prefs = {}
  STORE.next = 0
  as('user_1')
  vi.stubEnv('WEB_PUSH_VAPID_PUBLIC_KEY', keys.publicKey)
  vi.stubEnv('WEB_PUSH_VAPID_PRIVATE_KEY', keys.privateKey)
  vi.stubEnv('WEB_PUSH_SUBJECT', 'mailto:ops@example.org')
})

describe('GET /config', () => {
  it('hands out the public key, and says the feature is off without keys', async () => {
    expect(await client.config()).toEqual({ enabled: true, publicKey: keys.publicKey })
    vi.stubEnv('WEB_PUSH_VAPID_PUBLIC_KEY', '')
    vi.stubEnv('WEB_PUSH_VAPID_PRIVATE_KEY', '')
    vi.stubEnv('WEB_PUSH_SUBJECT', '')
    expect(await client.config()).toEqual({ enabled: false, publicKey: null })
  })
})

describe('devices', () => {
  it('registers the browser with a label made from its user agent, and lists it', async () => {
    const device = await client.registerDevice(sub('a'))
    expect(device).toMatchObject({ label: 'Safari auf iPhone', endpoint: sub('a').endpoint, lastSuccessAt: null })
    expect(await client.listDevices()).toEqual([device])
  })

  it('refreshes rather than duplicates when the browser registers again', async () => {
    await client.registerDevice(sub('a'))
    await client.registerDevice(sub('a'))
    expect(await client.listDevices()).toHaveLength(1)
  })

  it('replaces the endpoint a rotated subscription supersedes', async () => {
    await client.registerDevice(sub('old'))
    await client.registerDevice({ ...sub('new'), replaces: sub('old').endpoint })
    expect((await client.listDevices()).map((d) => d.endpoint)).toEqual([sub('new').endpoint])
  })

  // The worker posts a rotation for whoever is signed in when the push service
  // rotates. On a shared computer that may be B rotating A's subscription: B
  // must not take the browser over, and A's row stays until its next send 410s.
  it('refuses a rotation of an endpoint that is not one of the caller’s devices, and claims nothing', async () => {
    await client.registerDevice(sub('old'))
    as('user_2')
    await expect(client.registerDevice({ ...sub('new'), replaces: sub('old').endpoint })).rejects.toMatchObject({
      status: 409,
    })
    expect(await client.listDevices()).toEqual([])
    as('user_1')
    expect((await client.listDevices()).map((d) => d.endpoint)).toEqual([sub('old').endpoint])
  })

  it('refuses a rotation of an endpoint nobody holds', async () => {
    await expect(
      client.registerDevice({ ...sub('new'), replaces: sub('never-registered').endpoint })
    ).rejects.toMatchObject({ status: 409 })
    expect(await client.listDevices()).toEqual([])
  })

  // `new URL` and the `url.parse` web-push sends with read these hosts differently.
  it.each([';', '{', '`', '"', "'"])('refuses a host the sender’s parser would read as another (%s)', async (char) => {
    const endpoint = `https://169.254.169.254${char}.fcm.googleapis.com/x`
    await expect(client.registerDevice({ ...sub('a'), endpoint })).rejects.toMatchObject({ status: 400 })
    expect(await client.listDevices()).toEqual([])
  })

  it('refuses an address that is not a push service’s', async () => {
    await expect(client.registerDevice({ ...sub('a'), endpoint: 'https://169.254.169.254/x' })).rejects.toMatchObject({
      status: 400,
    })
  })

  it('answers like a missing route when the deployment has no keys', async () => {
    vi.stubEnv('WEB_PUSH_VAPID_PUBLIC_KEY', '')
    vi.stubEnv('WEB_PUSH_VAPID_PRIVATE_KEY', '')
    vi.stubEnv('WEB_PUSH_SUBJECT', '')
    await expect(client.registerDevice(sub('a'))).rejects.toMatchObject({ status: 404 })
  })

  it('shows a person only their own devices', async () => {
    await client.registerDevice(sub('a'))
    as('user_2')
    expect(await client.listDevices()).toEqual([])
    await client.registerDevice(sub('b'))
    expect(await client.listDevices()).toHaveLength(1)
  })

  it('moves a shared computer’s browser to whoever registered it last', async () => {
    await client.registerDevice(sub('shared'))
    as('user_2')
    await client.registerDevice(sub('shared'))
    as('user_1')
    expect(await client.listDevices()).toEqual([])
    as('user_2')
    expect(await client.listDevices()).toHaveLength(1)
  })

  it('removes a device of one’s own, and answers 404 for another person’s as for a missing one', async () => {
    const mine = await client.registerDevice(sub('a'))
    as('user_2')
    const theirs = await client.registerDevice(sub('b'))
    await expect(client.removeDevice(mine.id)).rejects.toMatchObject({ status: 404 })
    await client.removeDevice(theirs.id)
    await expect(client.removeDevice(theirs.id)).rejects.toBeInstanceOf(PushApiError)
    as('user_1')
    expect(await client.listDevices()).toHaveLength(1)
  })

  it('answers 404 for an id that is not even an id', async () => {
    await expect(client.removeDevice('not-a-uuid')).rejects.toMatchObject({ status: 404 })
  })
})

describe('preferences', () => {
  it('starts at the defaults and keeps what the person changes, leaving the rest', async () => {
    const start = await client.getPreferences()
    expect(start.showContent).toBe(true)
    expect(start.categories).toMatchObject({ requests: true, activity: false })
    const next = await client.updatePreferences({ showContent: false, categories: { activity: true } })
    expect(next).toMatchObject({ showContent: false, categories: { requests: true, activity: true } })
    expect(await client.getPreferences()).toEqual(next)
  })

  it('refuses a category that does not exist', async () => {
    await expect(
      client.updatePreferences({ categories: { nonsense: true } } as never)
    ).rejects.toMatchObject({ status: 400 })
  })
})
