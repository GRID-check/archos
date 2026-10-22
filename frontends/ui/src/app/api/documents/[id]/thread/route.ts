/**
 * The caller's own thread about one document (ADR-0106): POST returns its id,
 * creating it when it does not exist. The review canvas asks Piloti there, and
 * a wake of Piloti by one of the caller's replies runs there, so the two are
 * one conversation. Thin handler; the rules live in
 * `@/lib/annotations/document-thread`.
 */

import { apiRoute, parseJsonBody } from '@/lib/api/handler'
import { documentThreadRequestSchema } from '@/lib/annotations/types'
import { ensureDocumentThread } from '@/lib/annotations/document-thread'
import { getAccessibleDocument } from '@/lib/documents/access'

type Params = { id: string }

export const POST = apiRoute<Params>(
  async ({ session, request, params }) => {
    const { title } = await parseJsonBody(request, documentThreadRequestSchema)
    const doc = await getAccessibleDocument(session, params.id, 'read')
    return { conversationId: await ensureDocumentThread(session, doc, title) }
  },
  {
    authz: {
      enforcedBy: 'getAccessibleDocument (read) + ensureDocumentThread -> requireProjectAccess (project:chat)',
    },
  }
)
