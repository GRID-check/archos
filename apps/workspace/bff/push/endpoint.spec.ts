/**
 * @vitest-environment node
 */
import { describe, expect, it } from 'vitest'
import { isPushServiceEndpoint } from './endpoint'

describe('which addresses may be registered as a push endpoint', () => {
  it.each([
    'https://fcm.googleapis.com/fcm/send/abc',
    'https://updates.push.services.mozilla.com/wpush/v2/abc',
    'https://web.push.apple.com/QAbc',
    'https://wns2-par02p.notify.windows.com/w/?token=abc',
  ])('accepts %s', (endpoint) => {
    expect(isPushServiceEndpoint(endpoint)).toBe(true)
  })

  it.each([
    'http://fcm.googleapis.com/fcm/send/abc',
    'https://169.254.169.254/latest/meta-data',
    'https://metadata.google.internal/',
    'https://fcm.googleapis.com.evil.example/fcm/send/abc',
    'https://evilfcm.googleapis.com.example.org/',
    'https://user:pw@fcm.googleapis.com/x',
    'https://fcm.googleapis.com:8443/x',
    'https://localhost/x',
    // WHATWG URL reads an fcm host; Node's url.parse, which web-push sends
    // with, reads 169.254.169.254.
    'https://169.254.169.254;.fcm.googleapis.com/x',
    'https://169.254.169.254{.fcm.googleapis.com/x',
    'https://169.254.169.254`.fcm.googleapis.com/x',
    'https://169.254.169.254".fcm.googleapis.com/x',
    "https://169.254.169.254'.fcm.googleapis.com/x",
    'https://a_b.fcm.googleapis.com/x',
    'not a url',
    '',
  ])('refuses %s', (endpoint) => {
    expect(isPushServiceEndpoint(endpoint)).toBe(false)
  })
})
