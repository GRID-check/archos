/**
 * Ask Piloti (ADR-0124): `POST` → the ask, as `AskView`. An agent acting for
 * the person asks Piloti a question; Piloti answers in a turn run as that
 * person, in their own thread, on their budget. The request waits up to
 * `ASK_WAIT_SECONDS` for the answer and answers 200 with it, or 202 with the
 * ask still `working`, which `GET /api/piloti-asks/[id]` then polls.
 *
 * The MCP operation is `piloti-ask-create`; the A2A door's `SendMessage`
 * calls this route through the same dispatcher. Charged as a chat turn
 * (`chat-turn`), because it is one. Thin handler; the rules live in
 * `@/lib/piloti-asks/service`, the contract in `@/lib/piloti-asks/ask-wire`.
 */

import { apiRoute, parseJsonBody } from '@/lib/api/handler'
import { CHAT_TURN_LIMIT } from '@/lib/limits/catalog'
import { createAskSchema, isTerminalAskState } from '@/lib/piloti-asks/ask-wire'
import { askPiloti } from '@/lib/piloti-asks/service'

export const dynamic = 'force-dynamic'

export const POST = apiRoute(
  async ({ session, request }) => {
    const ask = await askPiloti(session, await parseJsonBody(request, createAskSchema))
    return Response.json(ask, { status: isTerminalAskState(ask.state) ? 200 : 202 })
  },
  {
    authz: {
      enforcedBy:
        'askPiloti (the piloti-ask flag; requireProjectAccess CHAT_PERMISSIONS on the project; a continued conversation must be one an ask of this person started)',
    },
    limits: { rule: CHAT_TURN_LIMIT },
  },
)
