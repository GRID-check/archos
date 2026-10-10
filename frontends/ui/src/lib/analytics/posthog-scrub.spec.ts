import { describe, expect, test } from 'vitest'
import { scrubDeep, scrubSensitiveQuery } from './posthog-scrub'

/**
 * The scrubber is the last lock before a URL leaves the browser, so each case
 * below is a place the app really does put a secret in one.
 */
describe('scrubSensitiveQuery', () => {
  test('removes the OAuth callback grant and state, keeping the path', () => {
    expect(scrubSensitiveQuery('https://app.example/api/auth/callback?code=abc123&state=xyz')).toBe(
      'https://app.example/api/auth/callback'
    )
  })

  test('removes only the sensitive parameters and keeps the rest in order', () => {
    expect(scrubSensitiveQuery('/api/documents/d1/image?org=o1&u=u1&v=thumb&exp=17&sig=deadbeef')).toBe(
      '/api/documents/d1/image?org=o1&u=u1&v=thumb&exp=17'
    )
    expect(scrubSensitiveQuery('/x?sig=1&a=b')).toBe('/x?a=b')
    expect(scrubSensitiveQuery('/x?a=b&token=t&c=d')).toBe('/x?a=b&c=d')
  })

  test('removes secrets from the fragment too (implicit OAuth flow)', () => {
    expect(scrubSensitiveQuery('/cb#access_token=abc&token_type=bearer')).toBe('/cb#token_type=bearer')
    expect(scrubSensitiveQuery('/cb#id_token=abc')).toBe('/cb')
  })

  test.each(['sig', 'token', 'secret', 'key', 'code', 'state', 'api_key', 'client_secret', 'refresh_token'])(
    'removes %s',
    (name) => {
      expect(scrubSensitiveQuery(`/p?${name}=value&keep=1`)).toBe('/p?keep=1')
    }
  )

  test('removes the signature from the percent-encoded URL next/image builds', () => {
    const src =
      '/_next/image?url=%2Fapi%2Fdocuments%2Fd1%2Fimage%3Forg%3Do1%26exp%3D17%26sig%3Ddeadbeef&w=640&q=75'
    const scrubbed = scrubSensitiveQuery(src)
    expect(scrubbed).not.toContain('deadbeef')
    expect(scrubbed).toBe('/_next/image?url=%2Fapi%2Fdocuments%2Fd1%2Fimage%3Forg%3Do1%26exp%3D17&w=640&q=75')
  })

  test('removes a secret inside prose or a stack line without eating the rest', () => {
    // The position suffix is ambiguous with the value (`abc:1:2`): losing it is the safe side.
    expect(scrubSensitiveQuery('at load (https://app.example/_next/x.js?token=abc:1:2)')).toBe(
      'at load (https://app.example/_next/x.js)'
    )
    expect(scrubSensitiveQuery('GET /a?code=1 failed')).toBe('GET /a failed')
  })

  test('leaves other parameters and unrelated text alone', () => {
    expect(scrubSensitiveQuery('/p?keyboard=1&monkey=2&statement=3')).toBe('/p?keyboard=1&monkey=2&statement=3')
    expect(scrubSensitiveQuery('Q&A: code is fun')).toBe('Q&A: code is fun')
    expect(scrubSensitiveQuery('')).toBe('')
  })
})

describe('scrubDeep', () => {
  test('reaches URLs nested in element chains, exception frames and person properties', () => {
    const event = {
      $current_url: 'https://app.example/cb?code=x&state=y',
      $elements: [{ tag_name: 'a', attr__href: '/api/documents/d/image?sig=zzz&exp=1' }],
      $exception_list: [
        { stacktrace: { frames: [{ filename: 'https://app.example/_next/a.js?key=k' }] } },
      ],
      $set_once: { $initial_referrer: 'https://idp.example/?code=c' },
      count: 3,
      flag: true,
      nothing: null,
    }
    const scrubbed = scrubDeep(event)
    expect(scrubbed.$current_url).toBe('https://app.example/cb')
    expect(scrubbed.$elements[0]!.attr__href).toBe('/api/documents/d/image?exp=1')
    expect(scrubbed.$exception_list[0]!.stacktrace.frames[0]!.filename).toBe('https://app.example/_next/a.js')
    expect(scrubbed.$set_once.$initial_referrer).toBe('https://idp.example/')
    expect(scrubbed).toMatchObject({ count: 3, flag: true, nothing: null })
  })

  test('does not mutate its input and returns it untouched when nothing matched', () => {
    const dirty = { u: '/a?code=1' }
    expect(scrubDeep(dirty)).toEqual({ u: '/a' })
    expect(dirty.u).toBe('/a?code=1')

    const clean = { u: '/a?b=1', list: [1, 'x'] }
    expect(scrubDeep(clean)).toBe(clean)
  })
})
