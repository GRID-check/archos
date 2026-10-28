/**
 * INTERNAL service endpoint: the chat socket reports how a headless turn ENDED
 * (ADR-0106, amended by ADR-0109). The BFF detaches from a woken turn once it
 * runs, so this is how the wake learns its end.
 *
 * Token-guarded (`internalApiRoute`). The body carries no organization: the
 * turn id is the wake's id, and the wake names its organization, so
 * `recordTurnOutcome` looks it up under platform access and does the rest as
 * that tenant. A turn that is no wake's (a browser's) is `{ settled: false }`.
 */

import { internalApiRoute, parseJsonBody } from '@/lib/api/handler'
import { recordTurnOutcome } from '@/lib/turns/outcome'
import { turnOutcomeRequestSchema } from '@/lib/turns/outcome-types'

export const POST = internalApiRoute(
  'Turn Outcome',
  async ({ request }) => recordTurnOutcome(await parseJsonBody(request, turnOutcomeRequestSchema)),
  { tenancy: { fromPayload: 'the wake named by body.turnId, whose organization the service reads from the wake' } }
)
