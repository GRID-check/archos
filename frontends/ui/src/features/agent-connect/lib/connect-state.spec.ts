import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { deriveAgentConnectState, loadAgentConnectState } from './connect-state'

const URL_OK = 'https://app.piloti.at/api/mcp'
const facts = { flagEnabled: true, doorConfigured: true, url: URL_OK, canAdminister: false }

describe('deriveAgentConnectState', () => {
  test('is ready, with the URL, when the door is configured and the flag is on', () => {
    expect(deriveAgentConnectState(facts)).toEqual({ availability: 'ready', url: URL_OK, canAdminister: false })
  })

  test('is org-disabled without the flag, and hides the URL', () => {
    expect(deriveAgentConnectState({ ...facts, flagEnabled: false })).toEqual({
      availability: 'org-disabled',
      url: null,
      canAdminister: false,
    })
  })

  test('is not-configured without the door, whatever the flag says', () => {
    expect(deriveAgentConnectState({ ...facts, doorConfigured: false, flagEnabled: false }).availability).toBe(
      'not-configured',
    )
    expect(deriveAgentConnectState({ ...facts, doorConfigured: false }).url).toBeNull()
  })

  test('is not-configured when no URL can be built', () => {
    expect(deriveAgentConnectState({ ...facts, url: null }).availability).toBe('not-configured')
  })

  test('passes canAdminister through in every state', () => {
    expect(deriveAgentConnectState({ ...facts, canAdminister: true }).canAdminister).toBe(true)
    expect(deriveAgentConnectState({ ...facts, flagEnabled: false, canAdminister: true }).canAdminister).toBe(true)
  })
})

describe('loadAgentConnectState', () => {
  const env = {
    WORKOS_AUTHKIT_DOMAIN: 'auth.example.com',
    WORKOS_REDIRECT_URI: 'https://app.piloti.at/api/auth/callback',
  }
  const session = (featureFlags: string[] | null, permissions: string[] = []) => ({
    featureFlags,
    role: 'member',
    permissions,
  })

  // `isFeatureEnabled` answers a fixed value where nobody signs in; pin the
  // deployment kind the way the flag specs do.
  beforeEach(() => vi.stubEnv('REQUIRE_AUTH', 'true'))
  afterEach(() => vi.unstubAllEnvs())

  test('a deployment that authenticates nobody has no entitlement, so the section stays off', () => {
    vi.stubEnv('REQUIRE_AUTH', 'false')
    expect(loadAgentConnectState(session(['agent-mcp']), env).availability).toBe('org-disabled')
  })

  test('reads the flag from the session, the URL from the app origin and the permission from the session', () => {
    const state = loadAgentConnectState(session(['agent-mcp'], ['org:settings:manage']), env)
    expect(state).toEqual({ availability: 'ready', url: URL_OK, canAdminister: true })
  })

  test('a session without the flag is org-disabled', () => {
    expect(loadAgentConnectState(session([]), env).availability).toBe('org-disabled')
  })

  test('a stale token (flags unknown) reads as off', () => {
    expect(loadAgentConnectState(session(null), env).availability).toBe('org-disabled')
  })

  test('no AuthKit domain is not-configured and exposes no URL', () => {
    const state = loadAgentConnectState(session(['agent-mcp']), { ...env, WORKOS_AUTHKIT_DOMAIN: ' ' })
    expect(state).toEqual({ availability: 'not-configured', url: null, canAdminister: false })
  })

  test('MCP_RESOURCE_URL overrides the derived URL', () => {
    const state = loadAgentConnectState(session(['agent-mcp']), { ...env, MCP_RESOURCE_URL: 'https://mcp.example.com/api/mcp' })
    expect(state.url).toBe('https://mcp.example.com/api/mcp')
  })
})
