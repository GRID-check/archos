/**
 * The caller's own thread about one document (ADR-0106): POST returns its id,
 * creating it when it does not exist. The review canvas asks Piloti there, and
 * a wake of Piloti by one of the caller's replies runs there, so the two are
 * one conversation. Thin handler; the rules live in
 * `@/lib/annotations/document-thread`.
 */

import { z } from 'zod'
import { apiRoute, parseJsonBody } from '@/lib/api/handler'
import { ensureDocumentThread } from '@/lib/annotations/document-thread'
import { getAccessibleDocument } from '@/lib/documents/access'

type Params = { id: string }

const threadRequestSchema = z.object({ title: z.string().trim().max(200).optional() }).strict()

export const POST = apiRoute<Params>(
  async ({ session, request, params }) => {
    const { title } = await parseJsonBody(request, threadRequestSchema)
    const doc = await getAccessibleDocument(session, params.id, 'read')
    return { conversationId: await ensureDocumentThread(session, doc, title) }
  },
  {
    authz: {
      enforcedBy: 'getAccessibleDocument (read) + ensureDocumentThread -> requireProjectAccess (project:chat)',
    },
  }
)
