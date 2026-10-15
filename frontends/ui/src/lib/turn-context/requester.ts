/**
 * Who is asking, by name: what the agent's prompt says about the person whose
 * turn it is.
 *
 * The agent cannot learn this on its own. It reads `name` and `email` off the
 * WorkOS access token, and the default WorkOS claims carry neither (no JWT
 * template, `docs/deployment/workos-provisioning.md`), so its `User:` line
 * rendered „Unknown (Unknown)" on every turn. The person is the signed
 * envelope's `userId`, never a body field, so a turn cannot be told it is
 * someone else.
 *
 * WorkOS is authoritative for identity and the app keeps no user table
 * (ADR-0007), so this is a cached WorkOS read, like the organization directory
 * (`lib/sharing/directory.ts`). That one is not reused because it keeps only
 * the joined display name, and the prompt wants the first name on its own.
 */

import 'server-only'
import { getCached } from '@/lib/cache'
import { getWorkOS } from '@/lib/workos/client'
import type { TurnContextRequester } from './wire'

const REQUESTER_TTL_MS = 5 * 60 * 1000

/** Empty strings read as absent: WorkOS leaves a name it does not know as `''` or null. */
function present(value: string | null | undefined): string | null {
  const trimmed = value?.trim()
  return trimmed ? trimmed : null
}

/**
 * The requester's first name, last name and email, or null when WorkOS cannot
 * say. Fails soft: a turn answers without the name rather than not at all. The
 * failure is caught outside `getCached`, so a WorkOS hiccup is never cached as
 * „nobody" for the TTL.
 */
export async function loadRequester(organizationId: string, userId: string): Promise<TurnContextRequester | null> {
  try {
    return await getCached(`requester:${organizationId}:${userId}`, REQUESTER_TTL_MS, async () => {
      const user = await getWorkOS().userManagement.getUser(userId)
      return {
        firstName: present(user.firstName),
        lastName: present(user.lastName),
        email: present(user.email),
      }
    })
  } catch (error) {
    console.warn(`[Turn Context API] Failed to load requester ${userId}:`, error)
    return null
  }
}
