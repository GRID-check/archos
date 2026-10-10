import { describe, expect, test, vi } from 'vitest'
import {
  DISABLED_POSTHOG_CONFIG,
  capturePosthog,
  getPosthogSessionId,
  identifyPosthog,
  initPosthogClient,
  isPosthogEnabled,
  resetPosthog,
} from './posthog'

/**
 * Fail-open contract: without a configured host/token the client never
 * initializes and every emit is a silent no-op. Analytics must never take
 * the app down with it — this is the ratchet for the dev-time throw the
 * PostHog wizard originally shipped.
 */
describe('posthog analytics facade', () => {
  test('stays disabled when initialized without configuration', () => {
    initPosthogClient('', '')
    expect(isPosthogEnabled()).toBe(false)
  })

  test('capture/identify/reset are silent no-ops while disabled', () => {
    expect(() => {
      capturePosthog('project_created')
      capturePosthog('skill_enabled_changed', { scope: 'curated', enabled: true })
      identifyPosthog('user-1', { email: 'a@example.test' })
      resetPosthog()
    }).not.toThrow()
    expect(isPosthogEnabled()).toBe(false)
  })

  test('has no session id while disabled', () => {
    expect(getPosthogSessionId()).toBeNull()
  })

  test('disabled config carries no host or token', () => {
    expect(DISABLED_POSTHOG_CONFIG).toEqual({ host: '', projectToken: '' })
  })
})

/**
 * The session id travels with each chat turn so Langfuse's PostHog export can
 * link a trace to its recording. It is read from the SDK, per call, and only
 * ever a UUID-shaped string; anything else is `null`.
 */
describe('posthog session id', () => {
  const load = async (sessionId: unknown) => {
    vi.resetModules()
    vi.doMock('posthog-js', () => ({ default: { init: vi.fn(), get_session_id: () => sessionId } }))
    return import('./posthog')
  }

  test('is the SDK session id once the client is initialized', async () => {
    const mod = await load('0199d7f2-5b3a-7c4e-9a1d-3e8f2b6c5d70')
    expect(mod.getPosthogSessionId()).toBeNull() // initialized only by init
    mod.initPosthogClient('https://eu.i.posthog.com', 'phc_test')
    expect(mod.getPosthogSessionId()).toBe('0199d7f2-5b3a-7c4e-9a1d-3e8f2b6c5d70')
  })

  test.each([[''], ['not-a-session'], [undefined], [42]])('is null for the SDK value %j', async (value) => {
    const mod = await load(value)
    mod.initPosthogClient('https://eu.i.posthog.com', 'phc_test')
    expect(mod.getPosthogSessionId()).toBeNull()
  })
})
