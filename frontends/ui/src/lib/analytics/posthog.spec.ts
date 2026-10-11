import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import type { CapturedNetworkRequest } from 'posthog-js'
import {
  DISABLED_POSTHOG_CONFIG,
  adoptServerIdentity,
  buildPosthogInitOptions,
  buildSessionRecordingOptions,
  capturePosthog,
  getPosthogSessionId,
  identifyPosthog,
  initPosthogClient,
  isPosthogEnabled,
  isPosthogOptedOut,
  maskReplayNetworkRequest,
  optInPosthog,
  optOutPosthog,
  registerPosthogContext,
  resetPosthog,
  scrubEvent,
  sendPosthogSupportMessage,
  stripUrlQuery,
  type PostHogConfig,
} from './posthog'
import {
  DEFAULT_REPLAY_SAMPLE_RATE,
  REPLAY_BLOCK_CLASS,
  parseReplaySampleRate,
  postHogConfigFromEnv,
  posthogAssetHost,
  posthogUiHost,
} from './posthog-config'

const sdk = vi.hoisted(() => ({
  init: vi.fn(),
  capture: vi.fn(),
  identify: vi.fn(),
  register: vi.fn(),
  unregister: vi.fn(),
  reset: vi.fn(),
  opt_out_capturing: vi.fn(),
  opt_in_capturing: vi.fn(),
  has_opted_out_capturing: vi.fn(() => false),
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
      registerPosthogContext({ organizationId: 'org_1', role: 'admin' })
      optOutPosthog()
      optInPosthog()
      resetPosthog()
    }).not.toThrow()
    expect(isPosthogOptedOut()).toBe(false)
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
      proxy: false,
    })
  })
})

describe('posthog browser configuration from the environment', () => {
  test('replay is on unless the deployment switches it off', () => {
    expect(postHogConfigFromEnv({}).sessionReplay).toBe(true)
    expect(postHogConfigFromEnv({ NEXT_PUBLIC_POSTHOG_SESSION_REPLAY: 'true' }).sessionReplay).toBe(true)
    expect(postHogConfigFromEnv({ NEXT_PUBLIC_POSTHOG_SESSION_REPLAY: 'false' }).sessionReplay).toBe(false)
    expect(postHogConfigFromEnv({ NEXT_PUBLIC_POSTHOG_SESSION_REPLAY: ' 0 ' }).sessionReplay).toBe(false)
    expect(postHogConfigFromEnv({ NEXT_PUBLIC_POSTHOG_SESSION_REPLAY: 'nonsense' }).sessionReplay).toBe(true)
  })

  test('the first-party proxy is on unless the deployment switches it off', () => {
    expect(postHogConfigFromEnv({}).proxy).toBe(true)
    expect(postHogConfigFromEnv({ NEXT_PUBLIC_POSTHOG_PROXY: 'false' }).proxy).toBe(false)
    expect(postHogConfigFromEnv({ NEXT_PUBLIC_POSTHOG_PROXY: '0' }).proxy).toBe(false)
    expect(postHogConfigFromEnv({ NEXT_PUBLIC_POSTHOG_PROXY: 'true' }).proxy).toBe(true)
  })

  test('every session is recorded unless the sample rate says otherwise, and nonsense is rejected', () => {
    expect(DEFAULT_REPLAY_SAMPLE_RATE).toBe(1)
    expect(parseReplaySampleRate(undefined)).toBe(1)
    expect(parseReplaySampleRate('')).toBe(1)
    expect(parseReplaySampleRate('abc')).toBe(1)
    expect(parseReplaySampleRate('1.5')).toBe(1)
    expect(parseReplaySampleRate('-0.1')).toBe(1)
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

  test('derives the app host and the asset host from a PostHog Cloud ingestion host', () => {
    expect(posthogUiHost('https://eu.i.posthog.com')).toBe('https://eu.posthog.com')
    expect(posthogUiHost('https://us.i.posthog.com/')).toBe('https://us.posthog.com')
    expect(posthogUiHost('https://ph.corp.example')).toBe('https://ph.corp.example')
    expect(posthogAssetHost('https://eu.i.posthog.com')).toBe('https://eu-assets.i.posthog.com')
    expect(posthogAssetHost('https://ph.corp.example/')).toBe('https://ph.corp.example')
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

  test('blocks anything carrying a signed capability URL, plain or as next/image encodes it', () => {
    const selector = recording.blockSelector ?? ''
    for (const attribute of ['src', 'srcset', 'href']) {
      expect(selector).toContain(`[${attribute}*="sig=" i]`)
      expect(selector).toContain(`[${attribute}*="sig%3D" i]`)
    }
  })

  test('keeps text masking exactly as wave 1 had it', () => {
    expect(recording.maskAllInputs).toBe(true)
    expect(recording.maskTextSelector).toBe('*')
  })

  test('records headers and bodies for the mask to narrow, and samples sessions', () => {
    expect(recording.recordHeaders).toBe(true)
    expect(recording.recordBody).toBe(true)
    expect(recording.sampleRate).toBe(0.2)
  })

  test('strips the query string and fragment from a recorded URL', () => {
    expect(stripUrlQuery('/api/images/abc?exp=1&sig=deadbeef')).toBe('/api/images/abc')
    expect(stripUrlQuery('https://app.example/x?sig=1#frag')).toBe('https://app.example/x')
    expect(stripUrlQuery('/plain')).toBe('/plain')
  })

  const request = (overrides: Partial<CapturedNetworkRequest>): CapturedNetworkRequest =>
    ({
      name: '/api/projects',
      entryType: 'resource',
      duration: 12,
      startTime: 5,
      method: 'POST',
      status: 200,
      requestHeaders: { 'content-type': 'application/json' },
      requestBody: '{"q":"Absturzhoehe"}',
      responseHeaders: { 'content-type': 'application/json' },
      responseBody: '{"answer":"..."}',
      ...overrides,
    }) as CapturedNetworkRequest

  test('keeps timing, drops the query and the bodies of a successful request', () => {
    const masked = maskReplayNetworkRequest(request({ name: '/api/images/abc?sig=deadbeef', method: 'GET' }))

    expect(masked.name).toBe('/api/images/abc')
    expect(masked).toMatchObject({ method: 'GET', status: 200, duration: 12 })
    expect(masked.requestBody).toBeUndefined()
    expect(masked.responseBody).toBeUndefined()
    expect(masked.requestHeaders).toEqual({ 'content-type': 'application/json' })
  })

  test('strips credentials and x-grid-* from recorded headers, in any case', () => {
    const masked = maskReplayNetworkRequest(
      request({
        requestHeaders: {
          Authorization: 'Bearer SECRET',
          cookie: 'wos-session=SECRET',
          'X-Grid-Internal-Token': 'SECRET',
          'x-grid-org': 'org_1',
          accept: 'application/json',
        },
        responseHeaders: { 'Set-Cookie': 'a=SECRET', 'content-type': 'application/json' },
      })
    )

    expect(masked.requestHeaders).toEqual({ accept: 'application/json' })
    expect(masked.responseHeaders).toEqual({ 'content-type': 'application/json' })
  })

  test('keeps the bodies of a failed request, which is what explains it', () => {
    const masked = maskReplayNetworkRequest(request({ status: 422, responseBody: '{"error":"invalid"}' }))
    expect(masked.requestBody).toBe('{"q":"Absturzhoehe"}')
    expect(masked.responseBody).toBe('{"error":"invalid"}')
  })

  test.each([
    '/api/organization/llm-credentials',
    '/api/organization/llm-credentials/openrouter',
    '/api/internal/skills/resolve',
    '/api/auth/callback',
    '/api/organization/audit-portal',
    '/api/platform/audit-portal',
  ])('never keeps a body for %s, even when it failed', (name) => {
    const masked = maskReplayNetworkRequest(
      request({
        name: `${name}?x=1`,
        status: 500,
        requestBody: '{"apiKey":"sk-SECRET"}',
        responseBody: '{"link":"https://x"}',
      })
    )
    expect(masked.requestBody).toBeUndefined()
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
  proxy: false,
}

const identity = {
  distinctId: 'user_01',
  organizationId: 'org_01',
  organizationName: 'Planungsbüro Muster',
  role: 'admin',
  locale: 'de',
}

describe('posthog init options', () => {
  test('keeps the anonymous id and the session across visits, cross-subdomain', () => {
    const options = buildPosthogInitOptions(enabledConfig)
    expect(options.persistence).toBe('localStorage+cookie')
    expect(options.cross_subdomain_cookie).toBe(true)
  })

  test('creates a person only for an identified user', () => {
    expect(buildPosthogInitOptions(enabledConfig).person_profiles).toBe('identified_only')
  })

  test('bootstraps the server-known user so the first pageview is identified', () => {
    expect(buildPosthogInitOptions(enabledConfig, identity).bootstrap).toEqual({
      distinctID: 'user_01',
      isIdentifiedID: true,
    })
  })

  test('a signed-out visitor gets no bootstrap', () => {
    expect('bootstrap' in buildPosthogInitOptions(enabledConfig)).toBe(false)
    expect('bootstrap' in buildPosthogInitOptions(enabledConfig, null)).toBe(false)
  })

  test('captures route changes, dead clicks, heatmaps and performance', () => {
    const options = buildPosthogInitOptions(enabledConfig)
    expect(options.capture_pageview).toBe('history_change')
    expect(options.capture_dead_clicks).toBe(true)
    expect(options.capture_heatmaps).toBe(true)
    expect(options.capture_performance).toBe(true)
  })

  test('the SDK masks the secret query keys in the URLs it owns', () => {
    const options = buildPosthogInitOptions(enabledConfig)
    expect(options.mask_personal_data_properties).toBe(true)
    expect(options.custom_personal_data_properties).toEqual(['sig', 'token', 'secret', 'key', 'code', 'state'])
  })

  test('autocapture keeps element text and attributes; the secrets are handled by exception', () => {
    const options = buildPosthogInitOptions(enabledConfig)
    expect(options.mask_all_text).toBe(false)
    expect(options.mask_all_element_attributes).toBe(false)
    expect(options.before_send).toBe(scrubEvent)
  })

  test('disables recording only when the deployment switches replay off', () => {
    expect(buildPosthogInitOptions(enabledConfig).disable_session_recording).toBe(true)
    expect(buildPosthogInitOptions({ ...enabledConfig, sessionReplay: true }).disable_session_recording).toBe(false)
  })

  test('carries the configured sample rate', () => {
    expect(
      buildPosthogInitOptions({ ...enabledConfig, sessionReplay: true, replaySampleRate: 0.05 }).session_recording
        ?.sampleRate
    ).toBe(0.05)
  })

  test('talks to PostHog directly without the proxy, and to /ingest with it', () => {
    const direct = buildPosthogInitOptions(enabledConfig)
    expect(direct.api_host).toBe('https://eu.i.posthog.com')
    expect('ui_host' in direct).toBe(false)

    const proxied = buildPosthogInitOptions({ ...enabledConfig, proxy: true })
    expect(proxied.api_host).toBe('/ingest')
    expect(proxied.ui_host).toBe('https://eu.posthog.com')
  })
})

describe('adoptServerIdentity', () => {
  const client = (current: string) => ({
    get_distinct_id: vi.fn(() => current),
    reset: vi.fn(),
    identify: vi.fn(),
  })

  test('does nothing when the SDK already holds the signed-in person', () => {
    const sdkClient = client('user_01')
    adoptServerIdentity(sdkClient, 'user_01')
    expect(sdkClient.reset).not.toHaveBeenCalled()
    expect(sdkClient.identify).not.toHaveBeenCalled()
  })

  // posthog-js keeps a DIFFERENT persisted, identified person and only logs a
  // warning: the new person's visit would be filed under the old one.
  test('resets before identifying when the browser still holds another person', () => {
    const sdkClient = client('user_00')
    adoptServerIdentity(sdkClient, 'user_01')
    expect(sdkClient.reset).toHaveBeenCalledTimes(1)
    expect(sdkClient.identify).toHaveBeenCalledWith('user_01')
    expect(sdkClient.reset.mock.invocationCallOrder[0]).toBeLessThan(sdkClient.identify.mock.invocationCallOrder[0]!)
  })

  test('is wired to init as the loaded callback only when the server knows the user', () => {
    expect(typeof buildPosthogInitOptions(enabledConfig, identity).loaded).toBe('function')
    expect('loaded' in buildPosthogInitOptions(enabledConfig)).toBe(false)
  })
})

describe('scrubEvent (before_send)', () => {
  const capture = (properties: Record<string, unknown>, event = '$pageview') =>
    ({ uuid: 'u', event, properties }) as Parameters<typeof scrubEvent>[0]

  test('an event whose URL carries ?code=x&state=y loses both', () => {
    const scrubbed = scrubEvent(
      capture({
        $current_url: 'https://app.example/api/auth/callback?code=x&state=y',
        $pathname: '/api/auth/callback',
        $referrer: 'https://idp.example/authorize?state=y&client=grid',
      })
    )
    expect(scrubbed?.properties).toEqual({
      $current_url: 'https://app.example/api/auth/callback',
      $pathname: '/api/auth/callback',
      $referrer: 'https://idp.example/authorize?client=grid',
    })
  })

  test('scrubs a click on a signed link, element chains and exception stacks', () => {
    const scrubbed = scrubEvent(
      capture(
        {
          $external_click_url: 'https://cdn.example/f.pdf?sig=abc',
          $elements: [{ tag_name: 'a', attr__href: '/api/documents/d/image?exp=1&sig=abc' }],
          $exception_list: [{ stacktrace: { frames: [{ filename: 'https://app.example/a.js?token=t' }] } }],
        },
        '$exception'
      )
    )
    expect(JSON.stringify(scrubbed)).not.toMatch(/sig=|token=|abc/)
  })

  test('scrubs person properties set with the event and passes a null through', () => {
    const scrubbed = scrubEvent({
      ...capture({}),
      $set_once: { $initial_current_url: 'https://app.example/cb?code=c' },
    } as NonNullable<Parameters<typeof scrubEvent>[0]>)
    expect(scrubbed?.$set_once).toEqual({ $initial_current_url: 'https://app.example/cb' })
    expect(scrubEvent(null)).toBeNull()
  })

  test('leaves a replay chunk payload alone but still scrubs its envelope', () => {
    const payload = [{ type: 3, data: { href: '/a?code=1' } }]
    const scrubbed = scrubEvent(capture({ $snapshot_data: payload, $current_url: '/a?code=1' }, '$snapshot'))
    expect(scrubbed?.properties.$snapshot_data).toBe(payload)
    expect(scrubbed?.properties.$current_url).toBe('/a')
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
      persistence: 'localStorage+cookie',
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

  test('context is registered as non-personal super properties, never a group', async () => {
    const mod = await load()
    mod.registerPosthogContext({
      organizationId: 'org_01',
      organizationName: 'Planungsbüro Muster',
      role: 'admin',
      locale: 'de',
    })
    expect(sdk.register).toHaveBeenCalledWith({
      organization_id: 'org_01',
      organization_name: 'Planungsbüro Muster',
      user_role: 'admin',
      locale: 'de',
    })
    expect(sdk.unregister).not.toHaveBeenCalled()
    expect('group' in sdk).toBe(false)
    expect(JSON.stringify(sdk.register.mock.calls)).not.toMatch(/email/)
  })

  test('a missing context field removes its stamp instead of keeping the previous one', async () => {
    const mod = await load()
    mod.registerPosthogContext({ organizationId: 'org_02', organizationName: null, role: undefined, locale: 'en' })
    expect(sdk.register).toHaveBeenCalledWith({ organization_id: 'org_02', locale: 'en' })
    expect(sdk.unregister).toHaveBeenCalledWith('organization_name')
    expect(sdk.unregister).toHaveBeenCalledWith('user_role')
  })

  test('opt-out and opt-in go to the SDK, which persists the choice', async () => {
    const mod = await load()
    mod.optOutPosthog()
    expect(sdk.opt_out_capturing).toHaveBeenCalledTimes(1)
    sdk.has_opted_out_capturing.mockReturnValue(true)
    expect(mod.isPosthogOptedOut()).toBe(true)
    mod.optInPosthog()
    expect(sdk.opt_in_capturing).toHaveBeenCalledTimes(1)
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
    mod.initPosthogClient({ host: 'https://eu.i.posthog.com', projectToken: 'phc_test', sessionReplay: false, replaySampleRate: 0, proxy: false })
    expect(mod.getPosthogSessionId()).toBe('0199d7f2-5b3a-7c4e-9a1d-3e8f2b6c5d70')
  })

  test.each([[''], ['not-a-session'], [undefined], [42]])('is null for the SDK value %j', async (value) => {
    const mod = await load(value)
    mod.initPosthogClient({ host: 'https://eu.i.posthog.com', projectToken: 'phc_test', sessionReplay: false, replaySampleRate: 0, proxy: false })
    expect(mod.getPosthogSessionId()).toBeNull()
  })
})
