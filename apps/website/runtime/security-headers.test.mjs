import assert from 'node:assert/strict'
import { test } from 'node:test'
import { contentSecurityPolicy, securityHeaders } from './security-headers.mjs'
import { analyticsOrigins } from './web-analytics.mjs'

const OFF = analyticsOrigins(null)
const ON = analyticsOrigins({ host: 'https://eu.i.posthog.com', token: 'phc_test' })

/** @param {string} csp */
function directive(csp, name) {
  const found = csp.split('; ').find((part) => part.startsWith(`${name} `))
  return found ? found.slice(name.length + 1).split(' ') : undefined
}

test('without analytics the policy allows the own origin only', () => {
  const csp = contentSecurityPolicy(OFF)
  assert.deepEqual(directive(csp, 'script-src'), ["'self'"])
  assert.deepEqual(directive(csp, 'connect-src'), ["'self'"])
  assert.doesNotMatch(csp, /posthog/)
})

test('with analytics the policy adds exactly the PostHog EU origins', () => {
  const csp = contentSecurityPolicy(ON)
  assert.deepEqual(directive(csp, 'script-src'), ["'self'", 'https://eu-assets.i.posthog.com'])
  assert.deepEqual(directive(csp, 'connect-src'), [
    "'self'",
    'https://eu.i.posthog.com',
    'https://eu-assets.i.posthog.com',
  ])
})

test('no inline or eval script is ever allowed, and the site cannot be framed', () => {
  for (const csp of [contentSecurityPolicy(OFF), contentSecurityPolicy(ON)]) {
    assert.doesNotMatch(directive(csp, 'script-src').join(' '), /unsafe/)
    assert.deepEqual(directive(csp, 'frame-ancestors'), ["'none'"])
    assert.deepEqual(directive(csp, 'object-src'), ["'none'"])
    assert.ok(directive(csp, 'form-action').includes('mailto:'), 'the forms fall back to mailto without JS')
  }
})

test('the full header set is present', () => {
  const names = securityHeaders(OFF).map(([name]) => name)
  for (const name of [
    'Content-Security-Policy',
    'Strict-Transport-Security',
    'X-Content-Type-Options',
    'X-Frame-Options',
    'Referrer-Policy',
    'Permissions-Policy',
  ]) {
    assert.ok(names.includes(name), name)
  }
})
