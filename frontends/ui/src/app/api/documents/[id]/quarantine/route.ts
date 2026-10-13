/**
 * What this session may do about one held document (ADR-0086): decide about it
 * (allow or delete) or ask for a decision. The Files preview reads it to offer
 * the right controls under the findings; the two actions still check for
 * themselves.
 */

import { apiRoute } from '@/lib/api/handler'
import { quarantineReviewAccess } from '@/lib/upload-screening/review'

type Params = { id: string }

export const GET = apiRoute<Params>(
  async ({ session, params }) => quarantineReviewAccess(session, params.id),
  {
    authz: {
      enforcedBy:
        'quarantineReviewAccess -> getAccessibleDocument (the shelf rule; a held file only for its uploader or a reviewer), then mayReviewQuarantine and the folder write release requires',
    },
  }
)
