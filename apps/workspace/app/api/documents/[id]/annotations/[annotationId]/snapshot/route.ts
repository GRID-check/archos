/**
 * The snapshot image of an Anmerkung's viewpoint: what the viewer showed when
 * the mark was set. Binary, so it is no agent operation. Gated like reading the
 * document. Thin handler; the rules live in `@/lib/annotations/viewpoint-read`.
 */

import { NextResponse } from 'next/server'
import { apiRoute } from '@/lib/api/handler'
import { readViewpointSnapshot } from '@/lib/annotations/viewpoint-read'

type Params = { id: string; annotationId: string }

export const GET = apiRoute<Params>(
  async ({ session, params }) => {
    const image = await readViewpointSnapshot(session, params.id, params.annotationId)
    return new NextResponse(new Uint8Array(image.bytes), {
      status: 200,
      headers: {
        'Content-Type': image.contentType,
        // A viewpoint never changes, but the mark may be deleted; the reader's access decides each time.
        'Cache-Control': 'private, no-store',
        'X-Content-Type-Options': 'nosniff',
      },
    })
  },
  { authz: { enforcedBy: 'readViewpointSnapshot -> getAccessibleDocument (read)' } }
)
