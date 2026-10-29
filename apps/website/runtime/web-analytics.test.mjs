import assert from 'node:assert/strict'
import vm from 'node:vm'
import { test } from 'node:test'
import {
  ANALYTICS_READY_EVENT,
  analyticsOrigins,
  sdkUrl,
  webAnalyticsConfig,
  webAnalyticsInitOptions,
  webAnalyticsScript,
} from './web-analytics.mjs'

const ENV = {
  PUBLIC_POSTHOG_HOST: 'https://eu.i.posthog.com',
  PUBLIC_POSTHOG_PROJECT_TOKEN: 'phc_test',
}

/** Runs the loader in a sandbox and returns what it did. */
function runLoader(body, extra = {}) {
  const appended = []
  const calls = []
  const dispatched = []
  const script = {}
  const window = {
    posthog: { init: (...args) => calls.push(args) },
    dispatchEvent: (event) => dispatched.push(event.type),
    ...extra,
  }
  const document = {
    createElement: () => script,
    head: { appendChild: (el) => appended.push(el) },
  }
  vm.runInNewContext(body, { window, document, Event, ...extra })
  return { appended, calls, dispatched, script }
}

test('analytics is off unless both the host and the token are set', () => {
  assert.equal(webAnalyticsConfig({}), null)
  assert.equal(webAnalyticsConfig({ PUBLIC_POSTHOG_HOST: ENV.PUBLIC_POSTHOG_HOST }), null)
  assert.equal(webAnalyticsConfig({ PUBLIC_POSTHOG_PROJECT_TOKEN: 'phc_test' }), null)
  assert.equal(webAnalyticsConfig({ ...ENV, PUBLIC_POSTHOG_PROJECT_TOKEN: '  ' }), null)
})

test('a host that is not an http(s) URL switches analytics off', () => {
  assert.equal(webAnalyticsConfig({ ...ENV, PUBLIC_POSTHOG_HOST: 'eu.i.posthog.com' }), null)
  assert.equal(webAnalyticsConfig({ ...ENV, PUBLIC_POSTHOG_HOST: 'javascript:alert(1)' }), null)
})

test('the host loses its trailing slash', () => {
  assert.deepEqual(webAnalyticsConfig({ ...ENV, PUBLIC_POSTHOG_HOST: 'https://eu.i.posthog.com/' }), {
    host: 'https://eu.i.posthog.com',
    token: 'phc_test',
  })
})

test('the SDK comes from the assets host on Cloud and from the proxy otherwise', () => {
  assert.equal(sdkUrl('https://eu.i.posthog.com'), 'https://eu-assets.i.posthog.com/static/array.js')
  assert.equal(sdkUrl('https://t.example.test'), 'https://t.example.test/static/array.js')
})

test('the init options match what the privacy policy says', () => {
  const options = webAnalyticsInitOptions({ host: 'https://eu.i.posthog.com', token: 'phc_test' })
  // No person profile for a visitor, no survey; a recording masks every input and text.
  assert.equal(options.person_profiles, 'identified_only')
  assert.deepEqual(options.session_recording, { maskAllInputs: true, maskTextSelector: '*' })
  assert.equal('disable_session_recording' in options, false)
  assert.equal(options.disable_surveys, true)
  // Pageviews, web vitals and heatmaps are measured.
  assert.equal(options.capture_pageview, 'history_change')
  assert.deepEqual(options.capture_performance, { web_vitals: true })
  assert.equal(options.enable_heatmaps, true)
  assert.equal(options.respect_dnt, true)
})

test('cookieless until the visitor accepts: on_reject, and no choice counts as not yet accepted', () => {
  const options = webAnalyticsInitOptions({ host: 'https://eu.i.posthog.com', token: 'phc_test' })
  // Pending consent is treated as rejected, and rejected means cookieless: the SDK's own wiring.
  assert.equal(options.cookieless_mode, 'on_reject')
  assert.equal(options.opt_out_capturing_by_default, true)
  // Nothing that would store across subdomains or change what accepting stores.
  assert.equal('persistence' in options, false)
  assert.equal('cross_subdomain_cookie' in options, false)
})

test('the CSP origins are the ingestion host and the assets host, and none when off', () => {
  assert.deepEqual(analyticsOrigins(null), { connect: [], script: [] })
  assert.deepEqual(analyticsOrigins({ host: 'https://eu.i.posthog.com', token: 'phc_test' }), {
    connect: ['https://eu.i.posthog.com', 'https://eu-assets.i.posthog.com'],
    script: ['https://eu-assets.i.posthog.com'],
  })
  assert.deepEqual(analyticsOrigins({ host: 'https://t.example.test/ingest', token: 'phc_test' }), {
    connect: ['https://t.example.test'],
    script: ['https://t.example.test'],
  })
})

test('the disabled script loads nothing', () => {
  const body = webAnalyticsScript(null)
  assert.match(body, /^\/\*/)
  assert.doesNotMatch(body, /createElement|posthog\.com/)
})

test('the enabled script is valid JavaScript that loads the SDK, inits it and tells the page', () => {
  const body = webAnalyticsScript({ host: 'https://eu.i.posthog.com', token: 'phc_test' })
  const { appended, calls, dispatched, script } = runLoader(body)
  assert.equal(appended.length, 1)
  assert.equal(script.src, 'https://eu-assets.i.posthog.com/static/array.js')
  assert.equal(calls.length, 0, 'init waits for the SDK to load')
  script.onload()
  assert.equal(calls.length, 1)
  assert.equal(calls[0][0], 'phc_test')
  assert.equal(calls[0][1].api_host, 'https://eu.i.posthog.com')
  assert.equal(calls[0][1].cookieless_mode, 'on_reject')
  assert.deepEqual(dispatched, [ANALYTICS_READY_EVENT], 'the consent note learns the SDK is there')
})

test('a token with script-breaking characters cannot escape the string', () => {
  const body = webAnalyticsScript({ host: 'https://eu.i.posthog.com', token: `x');alert(1);//` })
  const alerts = []
  const { calls, script } = runLoader(body, { alert: () => alerts.push('alert') })
  script.onload()
  assert.deepEqual(calls.map((c) => c[0]), [`x');alert(1);//`])
  assert.deepEqual(alerts, [])
})
