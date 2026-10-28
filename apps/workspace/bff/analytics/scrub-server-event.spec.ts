/**
 * @vitest-environment node
 */
import { describe, expect, test, vi } from 'vitest'

import { SENSITIVE_PARAMS, scrubServerEvent, scrubUrlString } from './scrub-server-event'

describe('scrubUrlString', () => {
  test.each(SENSITIVE_PARAMS)('removes the %s parameter and keeps the rest of the URL', (name) => {
    expect(scrubUrlString(`https://app.example/img/1?${name}=abc123&page=3`)).toBe(
      'https://app.example/img/1?page=3',
    )
    expect(scrubUrlString(`https://app.example/img/1?page=3&${name}=abc123`)).toBe(
      'https://app.example/img/1?page=3',
    )
  })

  test('drops the whole query when nothing but secrets was in it', () => {
    expect(scrubUrlString('/api/auth/callback?code=one-time&state=xyz')).toBe('/api/auth/callback')
  })

  test('matches names case-insensitively and after percent-decoding', () => {
    expect(scrubUrlString('https://x.example/a?SIG=1&%74oken=2&Page=4')).toBe('https://x.example/a?Page=4')
  })

  test('does not touch parameters that merely contain a sensitive word', () => {
    const url = 'https://x.example/a?keyword=brandschutz&tokens=3&encoded=1&statement=2'
    expect(scrubUrlString(url)).toBe(url)
  })

  test('scrubs a fragment that carries parameters', () => {
    expect(scrubUrlString('https://x.example/cb#access_token=abc&token=def&view=2')).toBe(
      'https://x.example/cb#access_token=abc&view=2',
    )
    expect(scrubUrlString('https://x.example/cb#token=def')).toBe('https://x.example/cb')
  })

  test('scrubs URLs quoted inside a longer message', () => {
    expect(
      scrubUrlString('GET https://x.example/img?sig=deadbeef&w=200 failed with 403 (see https://x.example/y?key=1)'),
    ).toBe('GET https://x.example/img?w=200 failed with 403 (see https://x.example/y)')
  })

  test('leaves strings without a query or fragment, and a bare question mark, alone', () => {
    expect(scrubUrlString('plain text')).toBe('plain text')
    expect(scrubUrlString('Was ist der Brandabschnitt?')).toBe('Was ist der Brandabschnitt?')
    expect(scrubUrlString('https://x.example/a#section')).toBe('https://x.example/a#section')
  })

  test('survives a malformed percent escape in a parameter name', () => {
    expect(scrubUrlString('https://x.example/a?%E0%A4%A=1&code=2')).toBe('https://x.example/a?%E0%A4%A=1')
  })
})

describe('scrubServerEvent', () => {
  test('scrubs nested properties, arrays and the person bags', () => {
    const event = {
      event: '$exception',
      properties: {
        $current_url: 'https://app.example/cb?code=abc&state=def',
        nested: { href: 'https://x.example/i?sig=1&w=2', list: ['/a?token=1', 'fine'] },
        count: 3,
        flag: true,
        nothing: null,
      },
      $set: { last_url: '/p?secret=1' },
      $set_once: { first_url: '/p?key=1&x=1' },
    }

    const scrubbed = scrubServerEvent(event)

    expect(scrubbed.properties).toEqual({
      $current_url: 'https://app.example/cb',
      nested: { href: 'https://x.example/i?w=2', list: ['/a', 'fine'] },
      count: 3,
      flag: true,
      nothing: null,
    })
    expect(scrubbed.$set).toEqual({ last_url: '/p' })
    expect(scrubbed.$set_once).toEqual({ first_url: '/p?x=1' })
    expect(scrubbed.event).toBe('$exception')
  })

  test('does not mutate the event it was given', () => {
    const event = { event: 'x', properties: { url: '/a?sig=1' } }

    scrubServerEvent(event)

    expect(event.properties.url).toBe('/a?sig=1')
  })

  test('passes null and events without properties through', () => {
    expect(scrubServerEvent(null)).toBeNull()
    expect(scrubServerEvent({ event: 'x' })).toEqual({ event: 'x' })
  })

  test('keeps Dates and other class instances as they are', () => {
    const at = new Date('2026-10-10T00:00:00Z')

    expect(scrubServerEvent({ event: 'x', properties: { at } }).properties?.at).toBe(at)
  })

  test('clears the properties instead of sending them unscrubbed when rewriting fails', () => {
    vi.spyOn(console, 'debug').mockImplementation(() => {})
    const hostile = {
      event: 'x',
      properties: {
        get boom(): string {
          throw new Error('getter exploded')
        },
      },
    }

    const scrubbed = scrubServerEvent(hostile)

    expect(scrubbed.event).toBe('x')
    expect(scrubbed.properties).toEqual({})
  })
})
