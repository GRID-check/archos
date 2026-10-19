import { act, renderHook, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_PUSH_PREFERENCES } from '@/lib/inbox/push-categories'
import type { PushClient } from '@/lib/push/client'
import type { PushDeviceView } from '@/lib/push/types'

const browser = vi.hoisted(() => ({
  support: 'default' as 'default' | 'granted' | 'denied' | 'unsupported' | 'needs-install',
  subscription: null as { endpoint: string; unsubscribe: () => Promise<boolean>; toJSON: () => unknown } | null,
  forgotten: 0,
  refuse: false,
}))

vi.mock('@/lib/push/browser', async (original) => {
  const real = await original<typeof import('@/lib/push/browser')>()
  return {
    ...real,
    readCapabilities: vi.fn(() => ({})),
    classifyPushSupport: vi.fn(() => browser.support),
    currentSubscription: vi.fn(async () => browser.subscription),
    subscribeThisDevice: vi.fn(async () => {
      if (browser.refuse) {
        // The person pressed Block on the browser's prompt.
        browser.support = 'denied'
        throw new real.PushPermissionError('denied')
      }
      browser.subscription = {
        endpoint: 'https://fcm.googleapis.com/fcm/send/mine',
        unsubscribe: vi.fn(async () => true),
        toJSON: () => ({ keys: { p256dh: 'p', auth: 'a' } }),
      }
      return browser.subscription as unknown as PushSubscription
    }),
    forgetThisDevice: vi.fn(async () => {
      browser.forgotten += 1
      browser.subscription = null
    }),
  }
})

import { refreshRegisteredDevice, usePushNotifications } from './use-push-notifications'

const device = (id: string, endpoint: string): PushDeviceView => ({
  id,
  label: 'Chrome auf Windows',
  endpoint,
  createdAt: '2026-10-01T00:00:00.000Z',
  lastSuccessAt: null,
})

function fakeClient(overrides: Partial<PushClient> = {}): PushClient & { devices: PushDeviceView[] } {
  const state = { devices: [] as PushDeviceView[] }
  const client: PushClient & { devices: PushDeviceView[] } = {
    get devices() {
      return state.devices
    },
    config: vi.fn(async () => ({ enabled: true, publicKey: 'AQID' })),
    listDevices: vi.fn(async () => state.devices),
    registerDevice: vi.fn(async (body) => {
      const created = device('new', body.endpoint)
      state.devices = [created]
      return created
    }),
    removeDevice: vi.fn(async (id) => {
      state.devices = state.devices.filter((entry) => entry.id !== id)
    }),
    getPreferences: vi.fn(async () => DEFAULT_PUSH_PREFERENCES),
    updatePreferences: vi.fn(async (patch) => ({
      showContent: patch.showContent ?? true,
      categories: { ...DEFAULT_PUSH_PREFERENCES.categories, ...patch.categories },
    })),
    ...overrides,
  }
  return client
}

beforeEach(() => {
  browser.support = 'default'
  browser.subscription = null
  browser.forgotten = 0
  browser.refuse = false
})

describe('usePushNotifications', () => {
  it('is off, and quiet, where the deployment has no keys', async () => {
    const client = fakeClient({ config: vi.fn(async () => ({ enabled: false, publicKey: null })) })
    const { result } = renderHook(() => usePushNotifications(client))
    await waitFor(() => expect(result.current.phase).toBe('off'))
    expect(client.listDevices).not.toHaveBeenCalled()
  })

  it('reports why a browser cannot, and still lists the person’s other devices', async () => {
    browser.support = 'needs-install'
    const client = fakeClient()
    client.devices.push(device('laptop', 'https://fcm.googleapis.com/fcm/send/laptop'))
    const { result } = renderHook(() => usePushNotifications(client))
    await waitFor(() => expect(result.current.phase).toBe('needs-install'))
    await waitFor(() => expect(result.current.devices).toHaveLength(1))
    expect(result.current.thisDeviceOn).toBe(false)
  })

  it('recognises this device among the registered ones by its endpoint', async () => {
    browser.support = 'granted'
    browser.subscription = { endpoint: 'https://fcm.googleapis.com/fcm/send/mine', unsubscribe: vi.fn(), toJSON: () => ({}) }
    const client = fakeClient()
    client.devices.push(device('mine', 'https://fcm.googleapis.com/fcm/send/mine'), device('other', 'https://x/other'))
    const { result } = renderHook(() => usePushNotifications(client))
    await waitFor(() => expect(result.current.thisDeviceOn).toBe(true))
    expect(result.current.thisDeviceId).toBe('mine')
  })

  it('does not treat a subscription another person left in this browser as this person’s device', async () => {
    browser.support = 'granted'
    browser.subscription = { endpoint: 'https://fcm.googleapis.com/fcm/send/left-behind', unsubscribe: vi.fn(), toJSON: () => ({}) }
    const client = fakeClient()
    const { result } = renderHook(() => usePushNotifications(client))
    await waitFor(() => expect(result.current.phase).toBe('ready'))
    await waitFor(() => expect(client.listDevices).toHaveBeenCalled())
    expect(result.current.thisDeviceOn).toBe(false)
  })

  it('turns on: subscribes in the browser, registers with the server, lists the device', async () => {
    const client = fakeClient()
    const { result } = renderHook(() => usePushNotifications(client))
    await waitFor(() => expect(result.current.phase).toBe('ready'))
    await act(() => result.current.enable())
    expect(client.registerDevice).toHaveBeenCalledWith({
      endpoint: 'https://fcm.googleapis.com/fcm/send/mine',
      keys: { p256dh: 'p', auth: 'a' },
    })
    expect(result.current.thisDeviceOn).toBe(true)
    expect(result.current.error).toBeNull()
  })

  it('reads a refused prompt as an answer: blocked, not failed', async () => {
    const client = fakeClient()
    const { result } = renderHook(() => usePushNotifications(client))
    await waitFor(() => expect(result.current.phase).toBe('ready'))
    browser.refuse = true
    await act(() => result.current.enable())
    expect(result.current.phase).toBe('denied')
    expect(result.current.error).toBeNull()
    expect(client.registerDevice).not.toHaveBeenCalled()
  })

  it('reports a server refusal as an error to retry', async () => {
    const client = fakeClient({ registerDevice: vi.fn(async () => Promise.reject(new Error('503'))) })
    const { result } = renderHook(() => usePushNotifications(client))
    await waitFor(() => expect(result.current.phase).toBe('ready'))
    await act(() => result.current.enable())
    expect(result.current.error).toBe('enable')
    expect(result.current.thisDeviceOn).toBe(false)
  })

  it('turns off by forgetting this device in the browser and on the server', async () => {
    browser.support = 'granted'
    browser.subscription = { endpoint: 'https://fcm.googleapis.com/fcm/send/mine', unsubscribe: vi.fn(), toJSON: () => ({}) }
    const client = fakeClient()
    client.devices.push(device('mine', 'https://fcm.googleapis.com/fcm/send/mine'))
    const { result } = renderHook(() => usePushNotifications(client))
    await waitFor(() => expect(result.current.thisDeviceOn).toBe(true))
    await act(() => result.current.disable())
    expect(browser.forgotten).toBe(1)
    expect(result.current.thisDeviceOn).toBe(false)
  })

  it('removes another device without touching this browser’s subscription', async () => {
    browser.support = 'granted'
    const unsubscribe = vi.fn(async () => true)
    browser.subscription = { endpoint: 'https://fcm.googleapis.com/fcm/send/mine', unsubscribe, toJSON: () => ({}) }
    const client = fakeClient()
    client.devices.push(device('mine', 'https://fcm.googleapis.com/fcm/send/mine'), device('laptop', 'https://x/laptop'))
    const { result } = renderHook(() => usePushNotifications(client))
    await waitFor(() => expect(result.current.devices).toHaveLength(2))
    await act(() => result.current.removeDevice('laptop'))
    expect(client.removeDevice).toHaveBeenCalledWith('laptop')
    expect(unsubscribe).not.toHaveBeenCalled()
    expect(result.current.devices.map((d) => d.id)).toEqual(['mine'])
  })

  it('unsubscribes the browser when the removed device is this one', async () => {
    browser.support = 'granted'
    const unsubscribe = vi.fn(async () => true)
    browser.subscription = { endpoint: 'https://fcm.googleapis.com/fcm/send/mine', unsubscribe, toJSON: () => ({}) }
    const client = fakeClient()
    client.devices.push(device('mine', 'https://fcm.googleapis.com/fcm/send/mine'))
    const { result } = renderHook(() => usePushNotifications(client))
    await waitFor(() => expect(result.current.thisDeviceOn).toBe(true))
    await act(() => result.current.removeDevice('mine'))
    expect(unsubscribe).toHaveBeenCalled()
    expect(result.current.thisDeviceOn).toBe(false)
  })

  it('saves a choice and shows what the server resolved', async () => {
    const client = fakeClient()
    const { result } = renderHook(() => usePushNotifications(client))
    await waitFor(() => expect(result.current.phase).toBe('ready'))
    await act(() => result.current.updatePreferences({ categories: { activity: true } }))
    expect(result.current.preferences.categories.activity).toBe(true)
  })
})

describe('refreshRegisteredDevice', () => {
  it('refreshes a device this person registered, and only that', async () => {
    browser.subscription = {
      endpoint: 'https://fcm.googleapis.com/fcm/send/mine',
      unsubscribe: vi.fn(),
      toJSON: () => ({ keys: { p256dh: 'p', auth: 'a' } }),
    }
    const client = fakeClient()
    client.devices.push(device('mine', 'https://fcm.googleapis.com/fcm/send/mine'))
    await refreshRegisteredDevice(client)
    expect(client.registerDevice).toHaveBeenCalledTimes(1)

    const other = fakeClient()
    await refreshRegisteredDevice(other)
    expect(other.registerDevice).not.toHaveBeenCalled()
  })

  it('does nothing without a subscription', async () => {
    browser.subscription = null
    const client = fakeClient()
    await refreshRegisteredDevice(client)
    expect(client.listDevices).not.toHaveBeenCalled()
  })
})
