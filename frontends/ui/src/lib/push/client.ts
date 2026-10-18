/**
 * The typed client for the push API (ADR-0055, ADR-0112): the paths, the verbs
 * and the parsed responses, written once. The settings section, the inbox prompt
 * and the service worker's re-subscribe all call this, and the route spec drives
 * the real handlers through it.
 *
 * Responses are parsed with the wire schemas, not cast, so a server a deploy
 * ahead or behind is a thrown {@link PushApiError} rather than a wrong shape.
 *
 * No `server-only`: the browser imports this.
 */

import type { ZodType } from 'zod'
import type { PushPreferencesPatch } from '@/lib/inbox/push-categories'
import {
  pushConfigResponseSchema,
  pushDevicesResponseSchema,
  pushPreferencesResponseSchema,
  registerDeviceResponseSchema,
  type PushConfigResponse,
  type PushDeviceView,
  type PushPreferencesResponse,
  type RegisterDeviceBody,
} from './types'

export type PushFetch = (path: string, init?: RequestInit) => Promise<Response>

const defaultFetch: PushFetch = (path, init) => fetch(path, init)

const BASE = '/api/notifications/push'

export class PushApiError extends Error {
  constructor(
    readonly status: number,
    message: string
  ) {
    super(message)
    this.name = 'PushApiError'
  }
}

export interface PushClient {
  config(): Promise<PushConfigResponse>
  listDevices(): Promise<PushDeviceView[]>
  registerDevice(body: RegisterDeviceBody): Promise<PushDeviceView>
  removeDevice(id: string): Promise<void>
  getPreferences(): Promise<PushPreferencesResponse['preferences']>
  updatePreferences(patch: PushPreferencesPatch): Promise<PushPreferencesResponse['preferences']>
}

export function createPushClient(request: PushFetch = defaultFetch): PushClient {
  async function call<T>(path: string, init: RequestInit | undefined, schema: ZodType<T> | null): Promise<T> {
    const response = await request(path, {
      cache: 'no-store',
      ...init,
      headers: { Accept: 'application/json', ...(init?.body ? { 'Content-Type': 'application/json' } : {}) },
    })
    if (!response.ok) throw new PushApiError(response.status, `${init?.method ?? 'GET'} ${path} answered ${response.status}`)
    if (!schema) return undefined as T
    const parsed = schema.safeParse(await response.json())
    if (!parsed.success) throw new PushApiError(502, `${path} answered a shape this client does not know`)
    return parsed.data
  }

  const json = (method: string, body: unknown): RequestInit => ({ method, body: JSON.stringify(body) })

  return {
    config: () => call(`${BASE}/config`, undefined, pushConfigResponseSchema),
    listDevices: async () => (await call(`${BASE}/devices`, undefined, pushDevicesResponseSchema)).devices,
    registerDevice: async (body) =>
      (await call(`${BASE}/devices`, json('POST', body), registerDeviceResponseSchema)).device,
    removeDevice: (id) => call(`${BASE}/devices/${encodeURIComponent(id)}`, { method: 'DELETE' }, null).then(() => undefined),
    getPreferences: async () => (await call(`${BASE}/preferences`, undefined, pushPreferencesResponseSchema)).preferences,
    updatePreferences: async (patch) =>
      (await call(`${BASE}/preferences`, json('PUT', patch), pushPreferencesResponseSchema)).preferences,
  }
}

export const pushClient: PushClient = createPushClient()
