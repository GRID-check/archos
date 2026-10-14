/**
 * The intake eval's BFF gate: the real `needs` and `record` logic of
 * `frontends/ui/src/lib/project-intake/`, served over stdin/stdout so the
 * Python harness (`scripts/intake_eval/harness.py`) can fake the route
 * in-process without a database.
 *
 * One JSON request per line in, one JSON answer per line out. The profile
 * lives in the harness and travels with every request, so this process holds
 * no state:
 *
 *   {"op":"empty"}                                   → {"profile"}
 *   {"op":"needs","profile","mode","dismissed"}      → {"needs"}
 *   {"op":"record","profile","body","readableFiles","dismissed"}
 *                                                    → {"status", "results"?, "opened"?, "profile"?, "error"?}
 *   {"op":"withdraw","profile","body"}               → {"status", "results"?, "profile"?, "error"?}
 *
 * `record` runs what `recordIntakeValues` in `service.ts` runs: the body
 * through `internalIntakeRequestSchema` (a malformed one answers 400), the
 * static screen of each value (`staticRefusal`), then `planRecord`, which
 * applies the values, derives the Gebäudeklasse and names the needs the batch
 * opened. `withdraw` runs `planWithdraw`, as `withdrawIntakeValues` does, with
 * the body's `jobId` as the reading. Two service steps are not
 * here: the quote is not masked (`documentEvidence` needs the organization's
 * screening policy, and the fixture holds no personal data), and the profile
 * write is the harness keeping the returned profile.
 *
 * Run from the repository root: `bun run scripts/intake_eval/gate.ts`.
 */

import { createInterface } from 'node:readline'
import { projectIntakeDefinitionV1 as definition } from '../../frontends/ui/src/lib/project-profile/intake-definition'
import type { DocumentEvidence } from '../../frontends/ui/src/lib/project-profile/evidence-schema'
import { emptyProjectProfile } from '../../frontends/ui/src/lib/project-profile/patch-engine'
import { ProjectProfileSchema, type ProjectProfile } from '../../frontends/ui/src/lib/project-profile/types'
import { computeNeeds } from '../../frontends/ui/src/lib/project-intake/needs'
import {
  planRecord,
  planWithdraw,
  staticRefusal,
  type ScreenedValue,
} from '../../frontends/ui/src/lib/project-intake/record'
import {
  internalIntakeRequestSchema,
  type DismissedValue,
  type IntakeMode,
  type RecordRefusalReason,
} from '../../frontends/ui/src/lib/project-intake/types'

interface GateRequest {
  op: 'empty' | 'needs' | 'record' | 'withdraw'
  profile?: unknown
  mode?: IntakeMode
  dismissed?: DismissedValue[]
  body?: unknown
  readableFiles?: string[]
}

type Screened = { key: string; screened: ScreenedValue | null; refusal: RecordRefusalReason | null }

/**
 * `reasonFromEvidence` of `lib/project-intake/evidence.ts`, restated: that module is
 * `server-only` (it masks through the screening service) and cannot load here.
 */
function reasonFromEvidence(evidence: Pick<DocumentEvidence, 'fileName' | 'page' | 'quote'>): string {
  const where = evidence.page ? `${evidence.fileName}, S. ${evidence.page}` : evidence.fileName
  return `${where}: „${evidence.quote}"`
}

function needs(request: GateRequest) {
  const profile = ProjectProfileSchema.parse(request.profile ?? {})
  return { needs: computeNeeds(profile, definition, { mode: request.mode ?? 'active', dismissed: request.dismissed ?? [] }) }
}

function record(request: GateRequest) {
  const parsed = internalIntakeRequestSchema.safeParse(request.body)
  if (!parsed.success || parsed.data.op !== 'record') {
    return { status: 400, error: parsed.success ? 'not a record body' : parsed.error.issues[0]?.message }
  }
  const profile: ProjectProfile = ProjectProfileSchema.parse(request.profile ?? {})
  const readableFiles = new Set(request.readableFiles ?? [])
  const dismissed = request.dismissed ?? []
  const screened: Screened[] = parsed.data.values.map((value) => {
    const refusal = staticRefusal(value, { definition, dismissed, readableFiles })
    if (refusal) return { key: value.key, screened: null, refusal }
    const evidence: DocumentEvidence = { kind: 'document', ...value.evidence }
    const reason = reasonFromEvidence(evidence)
    return { key: value.key, screened: { key: value.key, value: value.value, evidence, reason }, refusal: null }
  })
  const plan = planRecord(profile, definition, screened, {
    now: new Date().toISOString(),
    readingId: parsed.data.jobId,
    needs: { mode: request.mode ?? 'active', dismissed },
  })
  return { status: 200, results: plan.results, opened: plan.opened, profile: plan.profile }
}

function withdraw(request: GateRequest) {
  const parsed = internalIntakeRequestSchema.safeParse(request.body)
  if (!parsed.success || parsed.data.op !== 'withdraw') {
    return { status: 400, error: parsed.success ? 'not a withdraw body' : parsed.error.issues[0]?.message }
  }
  const profile: ProjectProfile = ProjectProfileSchema.parse(request.profile ?? {})
  const plan = planWithdraw(profile, definition, parsed.data.keys, {
    now: new Date().toISOString(),
    readingId: parsed.data.jobId,
  })
  return { status: 200, results: plan.results, profile: plan.profile }
}

function answer(request: GateRequest): unknown {
  if (request.op === 'empty') return { profile: emptyProjectProfile() }
  if (request.op === 'needs') return needs(request)
  if (request.op === 'record') return record(request)
  if (request.op === 'withdraw') return withdraw(request)
  return { status: 400, error: `unknown op ${String(request.op)}` }
}

const lines = createInterface({ input: process.stdin })
lines.on('line', (line) => {
  let reply: unknown
  try {
    reply = answer(JSON.parse(line) as GateRequest)
  } catch (error) {
    reply = { status: 500, error: error instanceof Error ? error.message : String(error) }
  }
  process.stdout.write(`${JSON.stringify(reply)}\n`)
})
