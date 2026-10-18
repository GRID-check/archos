/**
 * `/api/notifications/push/devices` — the signed-in person's own devices
 * (ADR-0112, ADR-0055).
 *
 * `GET` lists them, `POST` registers the calling browser or refreshes it (the
 * browser re-sends its subscription on every start, and when the push service
 * rotates it, with the endpoint it replaces). Whose devices is never a
 * parameter: the service reads it from the session.
 */

import { apiRoute, parseJsonBody } from '@/lib/api/handler'
import { listDevices, registerDevice } from '@/lib/push/service'
import { registerDeviceSchema } from '@/lib/push/types'

export const GET = apiRoute(async ({ session }) => ({ devices: await listDevices(session) }), {
  authz: { enforcedBy: 'listDevices (rows are keyed to session.userId)' },
})

export const POST = apiRoute(
  async ({ session, request }) => {
    const body = await parseJsonBody(request, registerDeviceSchema)
    return { device: await registerDevice(session, body, request.headers.get('user-agent')) }
  },
  { authz: { enforcedBy: 'registerDevice (rows are keyed to session.userId)' } }
)
