/**
 * Web Push devices and preferences — what a signed-in person may do with their
 * own notifications (ADR-0112, ADR-0055).
 *
 * Self-scoped like the inbox: every function reads the person from the session,
 * so there is no "whose devices" parameter to get wrong. The send side is
 * `./inbox-push-job.ts`; this is the side a request reaches.
 */

import 'server-only'
import { BadRequestError, ConflictError, NotFoundError } from '@/lib/api/errors'
import type { AuthorizedSession } from '@/lib/auth/types'
import { captureServer } from '@/lib/analytics/posthog-server'
import type { PushSubscriptionRow } from '@/lib/db/schema/push-subscriptions'
import {
  applyPushPreferencesPatch,
  resolvePushPreferences,
  type PushPreferences,
  type PushPreferencesPatch,
} from '@/lib/inbox/push-categories'
import { getUserPreferences, mergeUserPreferences } from '@/lib/user-preferences/service'
import { webPushConfig } from './config'
import { deviceLabelFromUserAgent } from './device-label'
import {
  claimEndpoint,
  deleteSubscription,
  deleteSubscriptionByEndpoint,
  listSubscriptions,
  MAX_DEVICES_PER_PERSON,
  trimSubscriptions,
  upsertSubscription,
} from './repository'
import { isSendableEndpoint } from './sender'
import type { PushConfigResponse, PushDeviceView, RegisterDeviceBody } from './types'

/** The key under which a person's choices live in `user_preferences.prefs`. */
export const PUSH_PREFERENCES_KEY = 'pushNotifications'

function toDeviceView(row: PushSubscriptionRow): PushDeviceView {
  return {
    id: row.id,
    label: row.deviceLabel,
    endpoint: row.endpoint,
    createdAt: row.createdAt.toISOString(),
    lastSuccessAt: row.lastSuccessAt ? new Date(row.lastSuccessAt).toISOString() : null,
  }
}

/** Whether this deployment has Web Push, and the public key a browser subscribes with. */
export function getPushConfig(): PushConfigResponse {
  const config = webPushConfig()
  return config ? { enabled: true, publicKey: config.publicKey } : { enabled: false, publicKey: null }
}

/**
 * Register this browser for the signed-in person, or refresh it.
 *
 * Without keys the feature does not exist, so the answer is the one for a route
 * that does not exist rather than a configuration error a person cannot act on.
 * The endpoint is claimed first (`claimEndpoint`): whoever held this browser
 * before no longer does.
 *
 * A rotation (`replaces`, sent by the worker on `pushsubscriptionchange`) is
 * only a rotation of the caller's OWN device. The worker posts with whoever is
 * signed in when the push service rotates, which on a shared computer may be
 * someone other than the person who turned notifications on. So the replaced
 * endpoint must be one of the caller's rows, or nothing is claimed and the
 * request is refused (409); the worker then unsubscribes the new address, and
 * the old row is dropped on its next send (410).
 */
export async function registerDevice(
  session: AuthorizedSession,
  body: RegisterDeviceBody,
  userAgent: string | null
): Promise<PushDeviceView> {
  if (!webPushConfig()) throw new NotFoundError()
  if (!isSendableEndpoint(body.endpoint)) throw new BadRequestError('Not a push service endpoint')
  const { organizationId, userId } = session
  if (body.replaces) {
    const replacedOwn = await deleteSubscriptionByEndpoint(organizationId, userId, body.replaces)
    if (!replacedOwn) throw new ConflictError('The replaced subscription is not one of your devices')
  }
  await claimEndpoint(organizationId, userId, body.endpoint)
  const row = await upsertSubscription({
    organizationId,
    userId,
    endpoint: body.endpoint,
    p256dh: body.keys.p256dh,
    auth: body.keys.auth,
    deviceLabel: deviceLabelFromUserAgent(userAgent),
  })
  await trimSubscriptions(organizationId, userId)
  captureServer({ event: 'push_device_registered', distinctId: userId, organizationId })
  return toDeviceView(row)
}

/** The signed-in person's devices, newest first. */
export async function listDevices(session: AuthorizedSession): Promise<PushDeviceView[]> {
  const rows = await listSubscriptions(session.organizationId, session.userId)
  return rows.slice(0, MAX_DEVICES_PER_PERSON).map(toDeviceView)
}

/**
 * Remove one of the person's own devices. A device that is not theirs answers
 * exactly like one that is not there, so the id cannot be used to probe.
 */
export async function removeDevice(session: AuthorizedSession, deviceId: string): Promise<void> {
  const removed = await deleteSubscription(session.organizationId, session.userId, deviceId)
  if (!removed) throw new NotFoundError()
  captureServer({ event: 'push_device_removed', distinctId: session.userId, organizationId: session.organizationId })
}

/** The person's choices, defaults filled in. */
export async function getPushPreferences(session: AuthorizedSession): Promise<PushPreferences> {
  const prefs = await getUserPreferences(session)
  return resolvePushPreferences(prefs[PUSH_PREFERENCES_KEY])
}

/** Change some of the person's choices; the resolved result. */
export async function updatePushPreferences(
  session: AuthorizedSession,
  patch: PushPreferencesPatch
): Promise<PushPreferences> {
  const next = applyPushPreferencesPatch(await getPushPreferences(session), patch)
  await mergeUserPreferences(session, { [PUSH_PREFERENCES_KEY]: next })
  return next
}
