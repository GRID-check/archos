import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  classifyPushSupport,
  deviceOfSubscription,
  forgetThisDevice,
  readCapabilities,
  urlBase64ToBytes,
  type PushCapabilities,
} from './browser'
import type { PushDeviceView } from './types'

const caps = (overrides: Partial<PushCapabilities> = {}): PushCapabilities => ({
  hasServiceWorker: true,
  hasPushManager: true,
  hasNotification: true,
  permission: 'default',
  isIos: false,
  isStandalone: false,
  ...overrides,
})

describe('where a browser stands on notifications', () => {
  it.each([
    ['a capable browser that has not been asked', caps(), 'default'],
    ['a capable browser that was allowed', caps({ permission: 'granted' }), 'granted'],
    ['a capable browser that was refused', caps({ permission: 'denied' }), 'denied'],
    ['a browser without a service worker', caps({ hasServiceWorker: false }), 'unsupported'],
    ['a browser without push', caps({ hasPushManager: false }), 'unsupported'],
    ['a browser without Notification', caps({ hasNotification: false, permission: null }), 'unsupported'],
    ['an iPhone in Safari (no push there at all)', caps({ isIos: true, hasPushManager: false, hasNotification: false }), 'needs-install'],
    ['an iPhone with Piloti on the Home Screen', caps({ isIos: true, isStandalone: true }), 'default'],
    ['an installed iPhone app that was refused', caps({ isIos: true, isStandalone: true, permission: 'denied' }), 'denied'],
  ])('%s', (_label, capabilities, expected) => {
    expect(classifyPushSupport(capabilities)).toBe(expected)
  })
})

describe('reading the capabilities', () => {
  const safariIphone = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 Version/17.4 Mobile/15E148 Safari/604.1'
  const win = (standalone: boolean) =>
    ({ matchMedia: () => ({ matches: standalone }), PushManager: {} }) as unknown as Window & typeof globalThis

  it('knows an iPhone, and whether it runs as an installed app', () => {
    const base = { userAgent: safariIphone, maxTouchPoints: 5, serviceWorker: {} } as unknown as Navigator
    expect(readCapabilities({ navigator: base, window: win(false) })).toMatchObject({ isIos: true, isStandalone: false })
    expect(readCapabilities({ navigator: base, window: win(true) })).toMatchObject({ isIos: true, isStandalone: true })
    const legacy = { ...base, standalone: true } as unknown as Navigator
    expect(readCapabilities({ navigator: legacy, window: win(false) }).isStandalone).toBe(true)
  })

  it('knows an iPad that calls itself a Mac', () => {
    const ipad = { userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Version/17.4 Safari/605.1.15', maxTouchPoints: 5 } as unknown as Navigator
    expect(readCapabilities({ navigator: ipad, window: win(false) }).isIos).toBe(true)
    const mac = { ...ipad, maxTouchPoints: 0 } as unknown as Navigator
    expect(readCapabilities({ navigator: mac, window: win(false) }).isIos).toBe(false)
  })

  it('reports nothing on the server', () => {
    expect(readCapabilities({})).toEqual({
      hasServiceWorker: false,
      hasPushManager: false,
      hasNotification: false,
      permission: null,
      isIos: false,
      isStandalone: false,
    })
  })
})

describe('keys and devices', () => {
  it('decodes a URL-safe base64 key', () => {
    expect(Array.from(urlBase64ToBytes('AQID'))).toEqual([1, 2, 3])
  })

  it('finds this browser among the person’s devices by its endpoint', () => {
    const device = (endpoint: string) => ({ id: endpoint, endpoint }) as PushDeviceView
    const devices = [device('https://a'), device('https://b')]
    expect(deviceOfSubscription(devices, { endpoint: 'https://b' } as PushSubscription)?.id).toBe('https://b')
    expect(deviceOfSubscription(devices, { endpoint: 'https://c' } as PushSubscription)).toBeNull()
    expect(deviceOfSubscription(devices, null)).toBeNull()
  })
})

describe('forgetting this browser, as sign-out does', () => {
  const ENDPOINT = 'https://fcm.googleapis.com/fcm/send/this'
  const device = (id: string, endpoint: string) => ({ id, endpoint }) as PushDeviceView

  function browserWith(order: string[]) {
    const notification = { close: vi.fn(() => order.push('close')) }
    const subscription = {
      endpoint: ENDPOINT,
      unsubscribe: vi.fn(async () => {
        order.push('unsubscribe')
        return true
      }),
    }
    const registration = {
      getNotifications: vi.fn(async () => [notification]),
      pushManager: { getSubscription: vi.fn(async () => subscription) },
    }
    const clearAppBadge = vi.fn(async () => {
      order.push('badge')
    })
    Object.defineProperty(navigator, 'serviceWorker', {
      configurable: true,
      value: { getRegistration: vi.fn(async () => registration) },
    })
    Object.defineProperty(navigator, 'clearAppBadge', { configurable: true, value: clearAppBadge })
    return { notification, subscription, clearAppBadge }
  }

  afterEach(() => {
    Reflect.deleteProperty(navigator, 'serviceWorker')
    Reflect.deleteProperty(navigator, 'clearAppBadge')
  })

  // A slow server used to outlast sign-out's budget with the browser still
  // subscribed, so the next person on the computer got the last one's inbox.
  it('unsubscribes, closes what is shown and clears the badge even when the server never answers', async () => {
    const order: string[] = []
    const { notification, subscription, clearAppBadge } = browserWith(order)
    const client = {
      listDevices: vi.fn(() => new Promise<never>(() => undefined)),
      removeDevice: vi.fn(),
    }
    await forgetThisDevice(client, { serverWithinMs: 5 })
    expect(subscription.unsubscribe).toHaveBeenCalledTimes(1)
    expect(notification.close).toHaveBeenCalledTimes(1)
    expect(clearAppBadge).toHaveBeenCalledTimes(1)
    expect(client.removeDevice).not.toHaveBeenCalled()
  })

  it('unsubscribes locally before it asks the server, then removes this browser’s row', async () => {
    const order: string[] = []
    browserWith(order)
    const client = {
      listDevices: vi.fn(async () => {
        order.push('list')
        return [device('other', 'https://fcm.googleapis.com/fcm/send/other'), device('mine', ENDPOINT)]
      }),
      removeDevice: vi.fn(async (id: string) => {
        order.push(`remove:${id}`)
      }),
    }
    await forgetThisDevice(client)
    expect(order.slice(order.indexOf('unsubscribe'))).toEqual(['unsubscribe', 'list', 'remove:mine'])
  })
})
