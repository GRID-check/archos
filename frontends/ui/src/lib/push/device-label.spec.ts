import { describe, expect, it } from 'vitest'
import { deviceLabelFromUserAgent } from './device-label'

describe('a device is named from its user agent', () => {
  it.each([
    [
      'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1',
      'Safari auf iPhone',
    ],
    [
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
      'Chrome auf Windows',
    ],
    [
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36 Edg/126.0.0.0',
      'Edge auf Windows',
    ],
    ['Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:127.0) Gecko/20100101 Firefox/127.0', 'Firefox auf Mac'],
    [
      'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36',
      'Chrome auf Android-Smartphone',
    ],
    [
      'Mozilla/5.0 (iPad; CPU OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/126.0 Mobile/15E148 Safari/604.1',
      'Chrome auf iPad',
    ],
  ])('%s', (ua, label) => {
    expect(deviceLabelFromUserAgent(ua)).toBe(label)
  })

  it('is never empty and never longer than the column allows', () => {
    expect(deviceLabelFromUserAgent(null)).toBe('Unbekanntes Gerät')
    expect(deviceLabelFromUserAgent('x'.repeat(5000)).length).toBeLessThanOrEqual(120)
  })
})
