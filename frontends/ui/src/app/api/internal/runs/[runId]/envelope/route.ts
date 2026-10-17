/**
 * INTERNAL service endpoint — a fresh signed envelope for a background run
 * (ADR-0108).
 *
 * The worker carries the envelope the BFF minted at submit and echoes it from
 * the run's tools, so they act as the person who commissioned the run. Once
 * that envelope is older than `RUN_ENVELOPE_RENEW_AFTER_MS` it asks here for a
 * new one. The run id in the path is the only thing it says; who the run acts
 * as is read off the `task_runs` row and re-checked against WorkOS as it is now
 * (`lib/runs/run-envelope.ts`). Python never signs.
 *
 * The wire is `lib/runs/run-envelope-types.ts`, exported as JSON Schema for the
 * worker's client. A refusal is `{error, message}` with its own status, not the
 * generic error envelope, because the worker branches on `error`: on any of the
 * three it runs on without an envelope and the person-acting tools refuse, as
 * every run did before ADR-0108. An outage is a 5xx and the worker keeps the
 * envelope it has.
 *
 * The response body is a credential for its six-hour window. Nothing here or in
 * the service logs it.
 */

import { NextResponse } from 'next/server'
import { BadRequestError } from '@/lib/api/errors'
import { internalApiRoute } from '@/lib/api/handler'
import { RUN_ENVELOPE_REFUSAL_STATUS, renewRunEnvelope } from '@/lib/runs/run-envelope'
import { runEnvelopeRequestSchema, type RunEnvelopeError } from '@/lib/runs/run-envelope-types'

type Params = { runId: string }

const NO_STORE = { 'cache-control': 'no-store' }

/**
 * The request carries nothing; an empty body and `{}` both say so. Anything
 * else is refused, so a body can never name a second run or an identity.
 */
async function requireEmptyBody(request: Request): Promise<void> {
  const text = await request.text()
  if (!text.trim()) return
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    throw new BadRequestError('Invalid JSON body')
  }
  if (!runEnvelopeRequestSchema.safeParse(raw).success) {
    throw new BadRequestError('The request carries nothing: the run id is the path')
  }
}

export const POST = internalApiRoute<Params>(
  'Run Envelope',
  async ({ request, params }) => {
    await requireEmptyBody(request)
    const outcome = await renewRunEnvelope(params.runId)
    // A credential: nothing between the two services may keep a copy.
    if (outcome.ok) return NextResponse.json(outcome.envelope, { headers: NO_STORE })
    const body: RunEnvelopeError = { error: outcome.refusal, message: outcome.message }
    return NextResponse.json(body, { status: RUN_ENVELOPE_REFUSAL_STATUS[outcome.refusal], headers: NO_STORE })
  },
  {
    tenancy: {
      fromPayload:
        'the task_runs row named by params.runId — resolved under platform access, then entered as that run’s organization and requester. The body names nothing',
    },
  },
)
