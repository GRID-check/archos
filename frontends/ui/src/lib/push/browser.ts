/**
 * The browser's half of Web Push (ADR-0112): what this browser can do, and the
 * few calls that turn notifications on and off for it.
 *
 * No `'server-only'`; every function that touches `window`, `navigator` or
 * `Notification` takes them as a parameter or guards for their absence, so the
 * server render and the specs can use the pure parts.
 *
 * ## Why a state, not a boolean
 *
 * "Can I turn notifications on?" has five answers a person needs to hear
 * differently: this browser cannot at all; this is an iPhone where it only works
 * once Piloti is on the Home Screen; the person said no and only their browser
 * settings can change that; they have not been asked yet; they said yes.
 */

import type { PushClient } from './client'
import type { PushDeviceView } from './types'

export type PushSupport = 'unsupported' | 'needs-install' | 'denied' | 'default' | 'granted'

export interface PushCapabilities {
  hasServiceWorker: boolean
  hasPushManager: boolean
  hasNotification: boolean
  permission: NotificationPermission | null
  isIos: boolean
  isStandalone: boolean
}

interface CapabilityEnvironment {
  navigator?: Navigator & { standalone?: boolean }
  window?: Window & typeof globalThis
  notification?: typeof Notification
}

/** Read what this browser offers. Safe on the server: everything is absent. */
export function readCapabilities(env: CapabilityEnvironment = browserEnvironment()): PushCapabilities {
  const nav = env.navigator
  const win = env.window
  const ua = nav?.userAgent ?? ''
  // iPadOS 13+ says it is a Mac; a touch screen on a "Mac" is an iPad.
  const isIos = /iPhone|iPad|iPod/.test(ua) || (/Macintosh/.test(ua) && (nav?.maxTouchPoints ?? 0) > 1)
  const isStandalone =
    nav?.standalone === true || (win?.matchMedia?.('(display-mode: standalone)').matches ?? false)
  return {
    hasServiceWorker: Boolean(nav && 'serviceWorker' in nav),
    hasPushManager: Boolean(win && 'PushManager' in win),
    hasNotification: Boolean(env.notification),
    permission: env.notification ? env.notification.permission : null,
    isIos,
    isStandalone,
  }
}

function browserEnvironment(): CapabilityEnvironment {
  if (typeof window === 'undefined') return {}
  return {
    navigator,
    window,
    notification: typeof Notification === 'undefined' ? undefined : Notification,
  }
}

/**
 * Where this browser stands. An iPhone or iPad outside the Home Screen app is
 * `needs-install` whatever else it reports: Safari there has no push at all,
 * and the fix is the install, not a newer browser.
 */
export function classifyPushSupport(caps: PushCapabilities): PushSupport {
  if (caps.isIos && !caps.isStandalone) return 'needs-install'
  if (!caps.hasServiceWorker || !caps.hasPushManager || !caps.hasNotification) return 'unsupported'
  if (caps.permission === 'denied') return 'denied'
  return caps.permission === 'granted' ? 'granted' : 'default'
}

/** A URL-safe base64 key as the bytes `pushManager.subscribe` takes. */
export function urlBase64ToBytes(value: string): Uint8Array<ArrayBuffer> {
  const padded = (value + '='.repeat((4 - (value.length % 4)) % 4)).replace(/-/g, '+').replace(/_/g, '/')
  const raw = atob(padded)
  const bytes = new Uint8Array(new ArrayBuffer(raw.length))
  for (let i = 0; i < raw.length; i += 1) bytes[i] = raw.charCodeAt(i)
  return bytes
}

function sameKey(subscription: PushSubscription, key: Uint8Array): boolean {
  const current = subscription.options.applicationServerKey
  if (!current) return false
  const bytes = new Uint8Array(current)
  return bytes.length === key.length && bytes.every((value, index) => value === key[index])
}

/** Register the worker. Idempotent; null when this browser has none or refuses. */
export async function registerWorker(): Promise<ServiceWorkerRegistration | null> {
  if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return null
  try {
    return await navigator.serviceWorker.register('/sw.js', { scope: '/', updateViaCache: 'none' })
  } catch {
    return null
  }
}

/** This browser's subscription, if it has one. Never prompts. */
export async function currentSubscription(): Promise<PushSubscription | null> {
  if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return null
  try {
    const registration = await navigator.serviceWorker.getRegistration('/')
    return (await registration?.pushManager.getSubscription()) ?? null
  } catch {
    return null
  }
}

/**
 * Ask for permission and subscribe this browser.
 *
 * The permission prompt is the first thing awaited, so it runs inside the
 * click's user gesture: Safari refuses it otherwise. A subscription made for a
 * different key (the operator rotated theirs) is replaced, because subscribing
 * over it throws.
 */
export async function subscribeThisDevice(publicKey: string): Promise<PushSubscription> {
  const permission = await Notification.requestPermission()
  if (permission !== 'granted') throw new PushPermissionError(permission)
  const registration = (await registerWorker()) ?? (await navigator.serviceWorker.ready)
  await navigator.serviceWorker.ready
  const key = urlBase64ToBytes(publicKey)
  const existing = await registration.pushManager.getSubscription()
  if (existing && sameKey(existing, key)) return existing
  if (existing) await existing.unsubscribe()
  return registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key })
}

export class PushPermissionError extends Error {
  constructor(readonly permission: NotificationPermission) {
    super(`notification permission is ${permission}`)
    this.name = 'PushPermissionError'
  }
}

/** The body the register route takes, from a browser subscription. */
export function registrationBody(subscription: PushSubscription): {
  endpoint: string
  keys: { p256dh: string; auth: string }
} {
  const json = subscription.toJSON()
  return {
    endpoint: subscription.endpoint,
    keys: { p256dh: json.keys?.p256dh ?? '', auth: json.keys?.auth ?? '' },
  }
}

/** Which of the person's devices this browser is: the one with its endpoint. */
export function deviceOfSubscription(
  devices: readonly PushDeviceView[],
  subscription: PushSubscription | null
): PushDeviceView | null {
  return subscription ? (devices.find((device) => device.endpoint === subscription.endpoint) ?? null) : null
}

/**
 * Stop notifying this browser: remove its device on the server and its
 * subscription in the browser. Best effort and quiet; used on sign-out, where a
 * shared computer must not keep showing the previous person's inbox, and in the
 * settings when a person turns it off.
 */
export async function forgetThisDevice(client: Pick<PushClient, 'listDevices' | 'removeDevice'>): Promise<void> {
  const subscription = await currentSubscription()
  if (!subscription) return
  try {
    const device = deviceOfSubscription(await client.listDevices(), subscription)
    if (device) await client.removeDevice(device.id)
  } catch {
    // The server could not be reached; the push service forgets the endpoint
    // once the browser unsubscribes, and the next send there answers 410.
  }
  await subscription.unsubscribe().catch(() => false)
}

/** Ask the worker to close notifications: those of these inbox items, or all of them. */
export type CloseNotificationsRequest = { itemIds: string[] } | { all: true }

export async function closeNotifications(request: CloseNotificationsRequest): Promise<void> {
  if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return
  const registration = await navigator.serviceWorker.getRegistration('/')
  registration?.active?.postMessage({ type: 'piloti:close-notifications', ...request })
}

/** The unread count on the app icon, where the platform has one. */
export function setAppBadge(count: number): void {
  if (typeof navigator === 'undefined') return
  const badging = navigator as Navigator & {
    setAppBadge?: (count?: number) => Promise<void>
    clearAppBadge?: () => Promise<void>
  }
  const call = count > 0 ? badging.setAppBadge?.(count) : badging.clearAppBadge?.()
  void call?.catch(() => undefined)
}
