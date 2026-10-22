/**
 * Conversation draft-preview API — read one unfiled draft into the browser.
 *
 * Thin handler; all logic lives in `@/lib/conversations/draft-preview`. The
 * card already names the draft (path, version, bytes); this is the door that
 * fetches its CONTENT so the reader can look at it before asking Piloti to
 * file it. Read-only end to end: the service calls the agent tier's `asearch`
 * / `aget` doors and never touches `grid_app`.
 */

import { apiRoute, parseQuery } from '@/lib/api/handler'
import { draftPreviewQuerySchema } from '@/lib/conversations/conversation-wire'
import { readConversationDraft } from '@/lib/conversations/draft-preview'

type Params = { id: string }

export const GET = apiRoute<Params>(
  async ({ session, params, request }) => {
    const { path } = parseQuery(request, draftPreviewQuerySchema)
    return readConversationDraft(session, params.id, path)
  },
  { authz: { enforcedBy: 'readConversationDraft (requireResourceAccess)' } },
)
