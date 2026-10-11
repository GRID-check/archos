import { beforeEach, describe, expect, test, vi } from 'vitest'

const capture = vi.fn()
const register = vi.fn(async (_properties: Record<string, unknown>) => {})
const constructed: Array<{ token: string; options: Record<string, unknown> }> = []

vi.mock('posthog-node', () => ({
  PostHog: class {
    capture = capture
    register = register
    shutdown = vi.fn(async () => {})
    constructor(token: string, options: Record<string, unknown>) {
      constructed.push({ token, options })
    }
  },
}))

import { captureServer, getPosthogServer, resetPosthogServerForTests } from './posthog-server'
import { scrubServerEvent } from './scrub-server-event'

const enable = (): void => {
  vi.stubEnv('NEXT_PUBLIC_POSTHOG_HOST', 'https://eu.i.posthog.com/')
  vi.stubEnv('NEXT_PUBLIC_POSTHOG_PROJECT_TOKEN', 'phc_test')
}

describe('captureServer', () => {
  beforeEach(() => {
    vi.unstubAllEnvs()
    vi.restoreAllMocks()
    capture.mockReset()
    register.mockClear()
    constructed.length = 0
    resetPosthogServerForTests()
  })

  test('is a no-op while PostHog is not configured: no client, nothing queued', () => {
    expect(captureServer({ event: 'user_signed_in', distinctId: 'user_1' })).toBe(false)

    expect(getPosthogServer()).toBeNull()
    expect(constructed).toHaveLength(0)
    expect(capture).not.toHaveBeenCalled()
  })

  test('is a no-op with only one of the two settings', () => {
    vi.stubEnv('NEXT_PUBLIC_POSTHOG_HOST', 'https://eu.i.posthog.com')

    expect(captureServer({ event: 'user_signed_in', distinctId: 'user_1' })).toBe(false)
    expect(constructed).toHaveLength(0)
  })

  test('queues the event under the acting user with the organization as a PROPERTY, never a group', () => {
    enable()

    const queued = captureServer({
      event: 'resource_shared',
      distinctId: 'user_1',
      organizationId: 'org_1',
      properties: { resource_type: 'document', role: 'collaborator' },
    })

    expect(queued).toBe(true)
    expect(capture).toHaveBeenCalledTimes(1)
    const sent = capture.mock.calls[0]?.[0] as Record<string, unknown>
    expect(sent).toEqual({
      event: 'resource_shared',
      distinctId: 'user_1',
      properties: { resource_type: 'document', role: 'collaborator', organization_id: 'org_1' },
    })
    expect(sent).not.toHaveProperty('groups')
  })

  // posthog-node sends an event without a distinct id under a fresh one, with
  // `$process_person_profile: false` (`_prepareEventMessage`), so no person is minted.
  test('a system action has no distinct id, which posthog-node makes personless', () => {
    enable()

    captureServer({
      event: 'job_run_started',
      distinctId: null,
      organizationId: 'org_1',
      properties: { job_id: 'j1' },
    })

    expect(capture).toHaveBeenCalledWith({
      event: 'job_run_started',
      distinctId: undefined,
      properties: { job_id: 'j1', organization_id: 'org_1' },
    })
  })

  test('every event carries the deployed commit and the service as super properties', () => {
    enable()
    vi.stubEnv('GRID_GIT_SHA', 'abc1234')
    vi.stubEnv('OTEL_SERVICE_NAME', 'grid-scheduler')

    getPosthogServer()
    getPosthogServer()

    expect(register).toHaveBeenCalledTimes(1)
    expect(register).toHaveBeenCalledWith({ release: 'abc1234', service: 'grid-scheduler' })
  })

  test('omits organization_id when the event has no organization', () => {
    enable()

    captureServer({ event: 'user_signed_in', distinctId: 'user_1', organizationId: null })

    const sent = capture.mock.calls[0]?.[0] as { properties: Record<string, unknown> }
    expect(sent.properties).not.toHaveProperty('organization_id')
  })

  test('never throws when the client does', () => {
    enable()
    vi.spyOn(console, 'debug').mockImplementation(() => {})
    capture.mockImplementation(() => {
      throw new Error('queue full')
    })

    expect(captureServer({ event: 'user_signed_in', distinctId: 'user_1' })).toBe(false)
  })

  test('the client is built once, with GeoIP off and the URL scrubber as its last hook', () => {
    enable()

    captureServer({ event: 'user_signed_in', distinctId: 'a' })
    captureServer({ event: 'user_signed_in', distinctId: 'b' })

    expect(constructed).toHaveLength(1)
    expect(constructed[0]?.token).toBe('phc_test')
    expect(constructed[0]?.options).toMatchObject({
      host: 'https://eu.i.posthog.com',
      disableGeoip: true,
    })
    expect(constructed[0]?.options.before_send).toBe(scrubServerEvent)
  })

  test('the hook the client is given strips a signed URL and an OAuth grant from an event', () => {
    enable()
    getPosthogServer()
    const beforeSend = constructed[0]?.options.before_send as typeof scrubServerEvent

    const sent = beforeSend({
      event: 'user_signed_in',
      properties: {
        callback: '/api/auth/callback?code=abc&state=def',
        image: 'https://x.example/i/1?sig=ff&w=2',
      },
    })

    expect(sent?.properties).toEqual({
      callback: '/api/auth/callback',
      image: 'https://x.example/i/1?w=2',
    })
  })
})
