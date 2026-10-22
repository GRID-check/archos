/**
 * Project profile patches API — apply agent-proposed patch operations to the
 * stored profile. Thin handler; normalization, unknown-pruning, and the
 * optimistic-concurrency rules live in `@/lib/project-profile/profile-service`.
 */

import { apiRoute, parseJsonBody } from '@/lib/api/handler'
import { patchProjectProfile } from '@/lib/project-profile/profile-service'
import { patchProfileSchema } from '@/lib/project-profile/profile-wire'
import { getLocale } from '@/i18n/server'

type Params = { id: string }

export const POST = apiRoute<Params>(
  async ({ session, params, request }) => {
    const { patch, conversationId } = await parseJsonBody(request, patchProfileSchema)
    const origin = conversationId ? { conversationId, locale: await getLocale() } : undefined
    return patchProjectProfile(session, params.id, patch, origin)
  },
  {
    authz: {
      enforcedBy:
        'patchProjectProfile (requireProjectAccess project:edit; with a conversationId, requireResourceAccess conversation viewer and the restricted-folder refusal)',
    },
  }
)
