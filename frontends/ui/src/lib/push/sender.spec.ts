/**
 * @vitest-environment node
 */
import { createRequire } from 'node:module'
import webpush, { generateVAPIDKeys } from 'web-push'
import { describe, expect, it, vi } from 'vitest'

vi.mock('server-only', () => ({}))

import { createWebPushSender, isSendableEndpoint, outcomeForStatus } from './sender'

describe('what a push service’s status means', () => {
  it.each([
    [201, 'delivered'],
    [404, 'gone'],
    [410, 'gone'],
    [429, 'transient'],
    [500, 'transient'],
    [503, 'transient'],
    [400, 'rejected'],
    [401, 'rejected'],
    [403, 'rejected'],
    [413, 'rejected'],
  ])('%i is %s', (status, kind) => {
    expect(outcomeForStatus(status).kind).toBe(kind)
  })
})

const keys = generateVAPIDKeys()
const config = { publicKey: keys.publicKey, privateKey: keys.privateKey, subject: 'mailto:ops@example.org' }
const target = { endpoint: 'https://fcm.googleapis.com/fcm/send/abc', p256dh: 'p', auth: 'a' }
const options = { ttlSeconds: 3600, urgency: 'high' as const, topic: 'tag' }

function libReturning(result: () => Promise<{ statusCode: number }>) {
  return { sendNotification: vi.fn(result) } as unknown as typeof webpush & { sendNotification: ReturnType<typeof vi.fn> }
}

describe('the sender over web-push', () => {
  it('passes TTL, urgency, topic and the VAPID identity to the library', async () => {
    const lib = libReturning(async () => ({ statusCode: 201 }))
    const outcome = await createWebPushSender(config, lib).send(target, '{"a":1}', options)
    expect(outcome).toEqual({ kind: 'delivered' })
    const [subscription, payload, sent] = lib.sendNotification.mock.calls[0]
    expect(subscription).toEqual({ endpoint: target.endpoint, keys: { p256dh: 'p', auth: 'a' } })
    expect(payload).toBe('{"a":1}')
    expect(sent).toMatchObject({
      TTL: 3600,
      urgency: 'high',
      topic: 'tag',
      vapidDetails: { subject: 'mailto:ops@example.org', publicKey: keys.publicKey },
    })
  })

  it('reads the status off the error the library throws', async () => {
    const gone = libReturning(() => Promise.reject(Object.assign(new Error('gone'), { statusCode: 410 })))
    expect(await createWebPushSender(config, gone).send(target, '{}', options)).toEqual({ kind: 'gone' })
    const busy = libReturning(() => Promise.reject(Object.assign(new Error('busy'), { statusCode: 503 })))
    expect(await createWebPushSender(config, busy).send(target, '{}', options)).toEqual({ kind: 'transient', status: 503 })
  })

  // A row written before the host rule, or by a path that skipped it: the
  // library would request what url.parse reads, 169.254.169.254.
  it('never hands the library an address its parser reads as another host, and drops the row', async () => {
    const lib = libReturning(async () => ({ statusCode: 201 }))
    const smuggled = { ...target, endpoint: 'https://169.254.169.254;.fcm.googleapis.com/x' }
    expect(await createWebPushSender(config, lib).send(smuggled, '{}', options)).toEqual({ kind: 'gone' })
    expect(lib.sendNotification).not.toHaveBeenCalled()
  })

  it('treats a network failure or timeout as worth another try', async () => {
    const lib = libReturning(() => Promise.reject(new Error('socket hang up')))
    expect(await createWebPushSender(config, lib).send(target, '{}', options)).toEqual({ kind: 'transient', status: null })
  })
})

describe('the wire the library produces for our options (RFC 8030, 8188, 8291, 8292)', () => {
  it('encrypts for the subscription’s own keys and signs with the VAPID pair', async () => {
    const { createECDH, randomBytes } = await import('node:crypto')
    // The browser's half: a P-256 key pair and a 16-byte auth secret.
    const browser = createECDH('prime256v1')
    browser.generateKeys()
    const authSecret = randomBytes(16)
    const subscription = {
      endpoint: target.endpoint,
      keys: { p256dh: browser.getPublicKey().toString('base64url'), auth: authSecret.toString('base64url') },
    }
    const plaintext = JSON.stringify({ version: 1, title: 'Hallo', url: '/app/inbox' })

    const request = webpush.generateRequestDetails(subscription, plaintext, {
      TTL: 3600,
      urgency: 'high',
      topic: 'tag',
      vapidDetails: { subject: config.subject, publicKey: config.publicKey, privateKey: config.privateKey },
    })

    expect(request.headers).toMatchObject({ TTL: 3600, Urgency: 'high', Topic: 'tag', 'Content-Encoding': 'aes128gcm' })
    expect(String(request.headers.Authorization)).toMatch(/^vapid t=[\w-]+\.[\w-]+\.[\w-]+, k=/)
    expect(String(request.headers.Authorization)).toContain(config.publicKey)

    // The push service cannot read it; the browser can.
    const ece = createRequire(import.meta.url)('http_ece') as {
      decrypt: (body: Buffer, params: Record<string, unknown>) => Buffer
    }
    const decrypted = ece.decrypt(request.body as Buffer, {
      version: 'aes128gcm',
      privateKey: browser,
      authSecret: authSecret.toString('base64url'),
    })
    expect(decrypted.toString('utf8')).toBe(plaintext)
    expect((request.body as Buffer).toString('utf8')).not.toContain('Hallo')
  })
})

describe('whether the library would request the host we checked', () => {
  it.each([';', '{', '`', '"', "'"])('refuses a host url.parse cuts at %s', (char) => {
    expect(isSendableEndpoint(`https://169.254.169.254${char}.fcm.googleapis.com/x`)).toBe(false)
  })

  it('accepts a push service’s address', () => {
    expect(isSendableEndpoint(target.endpoint)).toBe(true)
  })
})
