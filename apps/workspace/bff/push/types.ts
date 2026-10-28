/**
 * The push primitive's wire (ADR-0055): the bodies the routes accept, the views
 * they answer, shared by the routes, the service and the typed client.
 *
 * No `'server-only'` and no drizzle: the browser imports it.
 */

import { z } from 'zod'
import { isPushServiceEndpoint } from './endpoint'

const endpointSchema = z
  .string()
  .max(2048)
  .refine(isPushServiceEndpoint, { message: 'Not a push service endpoint' })

/**
 * `PushSubscription.toJSON()` as the browser produces it, plus the endpoint it
 * replaces when the browser rotated the subscription (`pushsubscriptionchange`).
 */
export const registerDeviceSchema = z.object({
  endpoint: endpointSchema,
  keys: z.object({
    p256dh: z.string().min(1).max(256),
    auth: z.string().min(1).max(256),
  }),
  /** The endpoint this one replaces; its row is removed in the same call. */
  replaces: endpointSchema.optional(),
})
export type RegisterDeviceBody = z.infer<typeof registerDeviceSchema>

/** One of the signed-in person's devices. */
export const pushDeviceViewSchema = z.object({
  id: z.string(),
  label: z.string(),
  /** The person's own subscription address, so the browser can tell which entry is itself. */
  endpoint: z.string(),
  createdAt: z.string(),
  /** The last time the push service accepted a message for it; null before the first. */
  lastSuccessAt: z.string().nullable(),
})
export type PushDeviceView = z.infer<typeof pushDeviceViewSchema>

/** `GET /api/notifications/push/config` */
export const pushConfigResponseSchema = z.object({
  /** False when this deployment has no VAPID keys: the UI draws nothing. */
  enabled: z.boolean(),
  publicKey: z.string().nullable(),
})
export type PushConfigResponse = z.infer<typeof pushConfigResponseSchema>

/** `GET /api/notifications/push/devices` */
export const pushDevicesResponseSchema = z.object({ devices: z.array(pushDeviceViewSchema) })
export type PushDevicesResponse = z.infer<typeof pushDevicesResponseSchema>

/** `POST /api/notifications/push/devices` */
export const registerDeviceResponseSchema = z.object({ device: pushDeviceViewSchema })
export type RegisterDeviceResponse = z.infer<typeof registerDeviceResponseSchema>

/** `GET` and `PUT /api/notifications/push/preferences` */
export const pushPreferencesResponseSchema = z.object({
  preferences: z.object({
    showContent: z.boolean(),
    categories: z.object({
      requests: z.boolean(),
      results: z.boolean(),
      access: z.boolean(),
      activity: z.boolean(),
      office: z.boolean(),
    }),
  }),
})
export type PushPreferencesResponse = z.infer<typeof pushPreferencesResponseSchema>
