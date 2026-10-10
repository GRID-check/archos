import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import type { CapturedNetworkRequest } from 'posthog-js'
import {
  DISABLED_POSTHOG_CONFIG,
  buildPosthogInitOptions,
  buildSessionRecordingOptions,
  capturePosthog,
  getPosthogSessionId,
  identifyPosthog,
  initPosthogClient,
  isPosthogEnabled,
  maskReplayNetworkRequest,
  resetPosthog,
  sendPosthogSupportMessage,
  setPosthogOrganization,
  stripUrlQuery,
  type PostHogConfig,
} from './posthog'
import {
  DEFAULT_REPLAY_SAMPLE_RATE,
  REPLAY_BLOCK_CLASS,
  parseReplaySampleRate,
  postHogConfigFromEnv,
} from './posthog-config'

const sdk = vi.hoisted(() => ({
  init: vi.fn(),
  capture: vi.fn(),
  identify: vi.fn(),
  register: vi.fn(),
  unregister: vi.fn(),
  reset: vi.fn(),
  conversations: {
    isAvailable: vi.fn(() => true),
    sendMessage: vi.fn(),
  },
}))

vi.mock('posthog-js', () => ({ default: sdk }))

/**
 * Fail-open contract: without a configured host/token the client never
 * initializes and every emit is a silent no-op. Analytics must never take
 * the app down with it — this is the ratchet for the dev-time throw the
 * PostHog wizard originally shipped.
 */
describe('posthog analytics facade', () => {
  test('stays disabled when initialized without configuration', () => {
    initPosthogClient(DISABLED_POSTHOG_CONFIG)
    expect(isPosthogEnabled()).toBe(false)
  })

  test('capture/identify/reset are silent no-ops while disabled', async () => {
    expect(() => {
      capturePosthog('project_created')
      capturePosthog('skill_enabled_changed', { scope: 'curated', enabled: true })
      identifyPosthog('user-1')
      setPosthogOrganization('org_1')
      resetPosthog()
    }).not.toThrow()
    await expect(sendPosthogSupportMessage('hello')).resolves.toBe(false)
    expect(isPosthogEnabled()).toBe(false)
  })

  test('has no session id while disabled', () => {
    expect(getPosthogSessionId()).toBeNull()
  })

  test('disabled config carries no host or token and records nothing', () => {
    expect(DISABLED_POSTHOG_CONFIG).toEqual({
      host: '',
      projectToken: '',
      sessionReplay: false,
      replaySampleRate: 0,
    })
  })
})

describe('posthog browser configuration from the environment', () => {
  test('replay is off unless the deployment switches it on', () => {
    expect(postHogConfigFromEnv({}).sessionReplay).toBe(false)
    expect(postHogConfigFromEnv({ NEXT_PUBLIC_POSTHOG_SESSION_REPLAY: 'false' }).sessionReplay).toBe(false)
    expect(postHogConfigFromEnv({ NEXT_PUBLIC_POSTHOG_SESSION_REPLAY: 'true' }).sessionReplay).toBe(true)
    expect(postHogConfigFromEnv({ NEXT_PUBLIC_POSTHOG_SESSION_REPLAY: ' 1 ' }).sessionReplay).toBe(true)
  })

  test('the sample rate defaults to protect the free tier and rejects nonsense', () => {
    expect(DEFAULT_REPLAY_SAMPLE_RATE).toBe(0.2)
    expect(parseReplaySampleRate(undefined)).toBe(0.2)
    expect(parseReplaySampleRate('')).toBe(0.2)
    expect(parseReplaySampleRate('abc')).toBe(0.2)
    expect(parseReplaySampleRate('1.5')).toBe(0.2)
    expect(parseReplaySampleRate('-0.1')).toBe(0.2)
    expect(parseReplaySampleRate('0.05')).toBe(0.05)
    expect(parseReplaySampleRate('0')).toBe(0)
    expect(parseReplaySampleRate('1')).toBe(1)
  })

  test('reads host and token as before', () => {
    expect(
      postHogConfigFromEnv({
        NEXT_PUBLIC_POSTHOG_HOST: 'https://eu.i.posthog.com',
        NEXT_PUBLIC_POSTHOG_PROJECT_TOKEN: 'phc_x',
      })
    ).toMatchObject({ host: 'https://eu.i.posthog.com', projectToken: 'phc_x' })
  })
})

describe('session replay privacy options', () => {
  const recording = buildSessionRecordingOptions(0.2)

  test('masks every input and every text node', () => {
    expect(recording.maskAllInputs).toBe(true)
    expect(recording.maskTextSelector).toBe('*')
  })

  test('blocks media and the document viewers, and records no canvas', () => {
    expect(recording.blockClass).toBe(REPLAY_BLOCK_CLASS)
    for (const tag of ['img', 'video', 'canvas', 'iframe']) {
      expect(recording.blockSelector).toContain(tag)
    }
    expect(recording.captureCanvas).toEqual({ recordCanvas: false })
  })

  test('captures no network payloads and samples sessions', () => {
    expect(recording.recordHeaders).toBe(false)
    expect(recording.recordBody).toBe(false)
    expect(recording.sampleRate).toBe(0.2)
  })

  test('strips the query string and fragment from a recorded URL', () => {
    expect(stripUrlQuery('/api/images/abc?exp=1&sig=deadbeef')).toBe('/api/images/abc')
    expect(stripUrlQuery('https://app.example/x?sig=1#frag')).toBe('https://app.example/x')
    expect(stripUrlQuery('/plain')).toBe('/plain')
  })

  test('the network mask keeps timing, drops query, headers and bodies', () => {
    const masked = maskReplayNetworkRequest({
      name: '/api/images/abc?sig=deadbeef',
      entryType: 'resource',
      duration: 12,
      startTime: 5,
      method: 'GET',
      status: 200,
      requestHeaders: { authorization: 'Bearer secret' },
      requestBody: '{"q":"Absturzhoehe"}',
      responseHeaders: { 'set-cookie': 'a=b' },
      responseBody: '{"answer":"..."}',
    } as CapturedNetworkRequest)

    expect(masked.name).toBe('/api/images/abc')
    expect(masked).toMatchObject({ method: 'GET', status: 200, duration: 12 })
    expect(masked.requestHeaders).toBeUndefined()
    expect(masked.requestBody).toBeUndefined()
    expect(masked.responseHeaders).toBeUndefined()
    expect(masked.responseBody).toBeUndefined()
  })

  test('is wired to the recorder through the init options', () => {
    expect(recording.maskCapturedNetworkRequestFn).toBe(maskReplayNetworkRequest)
  })
})

const enabledConfig: PostHogConfig = {
  host: 'https://eu.i.posthog.com',
  projectToken: 'phc_test',
  sessionReplay: false,
  replaySampleRate: 0.2,
}

describe('posthog init options', () => {
  test('keeps nothing in the browser, so the "strictly necessary cookies" statement stays true', () => {
    expect(buildPosthogInitOptions(enabledConfig).persistence).toBe('memory')
  })

  test('creates a person only for an identified user', () => {
    expect(buildPosthogInitOptions(enabledConfig).person_profiles).toBe('identified_only')
  })

  test('keeps element text and attributes out of autocapture', () => {
    const options = buildPosthogInitOptions(enabledConfig)
    expect(options.mask_all_text).toBe(true)
    expect(options.mask_all_element_attributes).toBe(true)
  })

  test('disables recording unless replay is configured', () => {
    expect(buildPosthogInitOptions(enabledConfig).disable_session_recording).toBe(true)
    expect(buildPosthogInitOptions({ ...enabledConfig, sessionReplay: true }).disable_session_recording).toBe(false)
  })

  test('carries the configured sample rate', () => {
    expect(
      buildPosthogInitOptions({ ...enabledConfig, sessionReplay: true, replaySampleRate: 0.05 }).session_recording
        ?.sampleRate
    ).toBe(0.05)
  })
})

/**
 * Enabled path against a mocked posthog-js. The module keeps `initialized` in a
 * closure, so each test re-imports it fresh.
 */
describe('posthog enabled path', () => {
  const load = async (): Promise<typeof import('./posthog')> => {
    vi.resetModules()
    const mod = await import('./posthog')
    mod.initPosthogClient(enabledConfig)
    return mod
  }

  beforeEach(() => {
    vi.clearAllMocks()
    sdk.conversations.isAvailable.mockReturnValue(true)
    sdk.conversations.sendMessage.mockResolvedValue({ ticket_id: 't1' })
  })

  afterEach(() => {
    vi.resetModules()
  })

  test('initializes once with the token and the privacy options', async () => {
    const mod = await load()
    mod.initPosthogClient(enabledConfig)

    expect(sdk.init).toHaveBeenCalledTimes(1)
    const [token, options] = sdk.init.mock.calls[0]!
    expect(token).toBe('phc_test')
    expect(options).toMatchObject({
      api_host: 'https://eu.i.posthog.com',
      persistence: 'memory',
      person_profiles: 'identified_only',
      disable_session_recording: true,
    })
    expect(mod.isPosthogEnabled()).toBe(true)
  })

  test('identify sends the distinct id and nothing else', async () => {
    const mod = await load()
    mod.identifyPosthog('user_01')
    expect(sdk.identify.mock.calls).toEqual([['user_01']])
  })

  test('the organization is a super property, removed when there is none, and never a group', async () => {
    const mod = await load()
    mod.setPosthogOrganization('org_01')
    expect(sdk.register).toHaveBeenCalledWith({ organization_id: 'org_01' })
    mod.setPosthogOrganization(undefined)
    expect(sdk.unregister).toHaveBeenCalledWith('organization_id')
    expect('group' in sdk).toBe(false)
  })

  test('reset clears the PostHog identity', async () => {
    const mod = await load()
    mod.resetPosthog()
    expect(sdk.reset).toHaveBeenCalledTimes(1)
  })

  test('support: opens a new ticket without traits when Support is available', async () => {
    const mod = await load()
    await expect(mod.sendPosthogSupportMessage('[bug] it broke')).resolves.toBe(true)
    // Third argument true = always a new ticket; second undefined = no email/name traits.
    expect(sdk.conversations.sendMessage).toHaveBeenCalledWith('[bug] it broke', undefined, true)
  })

  test('support: reports false and sends nothing when Support is not available', async () => {
    sdk.conversations.isAvailable.mockReturnValue(false)
    const mod = await load()
    await expect(mod.sendPosthogSupportMessage('hi')).resolves.toBe(false)
    expect(sdk.conversations.sendMessage).not.toHaveBeenCalled()
  })

  test('support: a failing request never throws into the first-party submit', async () => {
    sdk.conversations.sendMessage.mockRejectedValue(new Error('offline'))
    const mod = await load()
    await expect(mod.sendPosthogSupportMessage('hi')).resolves.toBe(false)
  })

  test('support: a null response (not loaded yet) is not a success', async () => {
    sdk.conversations.sendMessage.mockResolvedValue(null)
    const mod = await load()
    await expect(mod.sendPosthogSupportMessage('hi')).resolves.toBe(false)
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
    mod.initPosthogClient({ host: 'https://eu.i.posthog.com', projectToken: 'phc_test', sessionReplay: false, replaySampleRate: 0 })
    expect(mod.getPosthogSessionId()).toBe('0199d7f2-5b3a-7c4e-9a1d-3e8f2b6c5d70')
  })

  test.each([[''], ['not-a-session'], [undefined], [42]])('is null for the SDK value %j', async (value) => {
    const mod = await load(value)
    mod.initPosthogClient({ host: 'https://eu.i.posthog.com', projectToken: 'phc_test', sessionReplay: false, replaySampleRate: 0 })
    expect(mod.getPosthogSessionId()).toBeNull()
  })
})
