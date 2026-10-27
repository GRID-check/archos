/**
 * @vitest-environment node
 */
import { generateVAPIDKeys } from 'web-push'
import { describe, expect, it, vi } from 'vitest'

vi.mock('server-only', () => ({}))

import { webPushConfig, webPushConfigProblem } from './config'

const keys = generateVAPIDKeys()
const valid = {
  WEB_PUSH_VAPID_PUBLIC_KEY: keys.publicKey,
  WEB_PUSH_VAPID_PRIVATE_KEY: keys.privateKey,
  WEB_PUSH_SUBJECT: 'mailto:betrieb@example.org',
}

describe('Web Push configuration', () => {
  it('is on with a real key pair and a contact', () => {
    expect(webPushConfig(valid)).toEqual({
      publicKey: keys.publicKey,
      privateKey: keys.privateKey,
      subject: 'mailto:betrieb@example.org',
    })
  })

  it('is off, silently, with nothing set', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    expect(webPushConfig({})).toBeNull()
    expect(warn).not.toHaveBeenCalled()
    warn.mockRestore()
  })

  it('is off, and says why once, with a half-set or malformed pair', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const broken = { ...valid, WEB_PUSH_VAPID_PRIVATE_KEY: undefined }
    expect(webPushConfig(broken)).toBeNull()
    expect(webPushConfig(broken)).toBeNull()
    expect(warn).toHaveBeenCalledTimes(1)
    warn.mockRestore()
  })

  it.each([
    ['a public key of the wrong length', { WEB_PUSH_VAPID_PUBLIC_KEY: 'AAAA' }],
    ['a private key that is not base64url', { WEB_PUSH_VAPID_PRIVATE_KEY: 'not base64!' }],
    ['a subject that is neither mailto: nor https:', { WEB_PUSH_SUBJECT: 'ops@example.org' }],
  ])('rejects %s', (_label, override) => {
    expect(webPushConfigProblem({ ...valid, ...override })).not.toBeNull()
  })
})
