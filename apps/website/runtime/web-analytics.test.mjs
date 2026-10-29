import assert from 'node:assert/strict'
import vm from 'node:vm'
import { test } from 'node:test'
import {
  sdkUrl,
  webAnalyticsConfig,
  webAnalyticsInitOptions,
  webAnalyticsScript,
} from './web-analytics.mjs'

const ENV = {
  PUBLIC_POSTHOG_HOST: 'https://eu.i.posthog.com',
  PUBLIC_POSTHOG_PROJECT_TOKEN: 'phc_test',
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
  // No person profile for a visitor, no screen recording, no survey.
  assert.equal(options.person_profiles, 'identified_only')
  assert.equal(options.disable_session_recording, true)
  assert.equal(options.disable_surveys, true)
  // Pageviews, web vitals and heatmaps are measured; the cookie crosses subdomains.
  assert.equal(options.capture_pageview, 'history_change')
  assert.deepEqual(options.capture_performance, { web_vitals: true })
  assert.equal(options.enable_heatmaps, true)
  assert.equal(options.cross_subdomain_cookie, true)
  assert.equal(options.respect_dnt, true)
})

test('the disabled script loads nothing', () => {
  const body = webAnalyticsScript(null)
  assert.match(body, /^\/\*/)
  assert.doesNotMatch(body, /createElement|posthog\.com/)
})

test('the enabled script is valid JavaScript that loads the SDK and then inits it', () => {
  const body = webAnalyticsScript({ host: 'https://eu.i.posthog.com', token: 'phc_test' })
  const appended = []
  const calls = []
  const script = {}
  const window = { posthog: { init: (...args) => calls.push(args) } }
  const document = {
    createElement: () => script,
    head: { appendChild: (el) => appended.push(el) },
  }
  vm.runInNewContext(body, { window, document })
  assert.equal(appended.length, 1)
  assert.equal(script.src, 'https://eu-assets.i.posthog.com/static/array.js')
  assert.equal(calls.length, 0, 'init waits for the SDK to load')
  script.onload()
  assert.equal(calls.length, 1)
  assert.equal(calls[0][0], 'phc_test')
  assert.equal(calls[0][1].api_host, 'https://eu.i.posthog.com')
  assert.equal(calls[0][1].disable_session_recording, true)
})

test('a token with script-breaking characters cannot escape the string', () => {
  const body = webAnalyticsScript({ host: 'https://eu.i.posthog.com', token: `x');alert(1);//` })
  const calls = []
  const script = {}
  const window = { posthog: { init: (...args) => calls.push(args) }, alert: () => calls.push('alert') }
  vm.runInNewContext(body, {
    window,
    alert: window.alert,
    document: { createElement: () => script, head: { appendChild: () => {} } },
  })
  script.onload()
  assert.deepEqual(calls.map((c) => (Array.isArray(c) ? c[0] : c)), [`x');alert(1);//`])
})
