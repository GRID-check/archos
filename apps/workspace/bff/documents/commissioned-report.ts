/**
 * A reader opened a finished run's report: file it into the project the run was
 * commissioned in, if that is a promise anyone made.
 *
 * Called by the jobs proxy (`app/api/jobs/async/[...path]/route.ts`) when a
 * reader's GET of `job/{id}/report` returns; the route only matches the path
 * and turns the outcome into the response's additive keys (ADR-0017). What a
 * filed report looks like, and the queueing itself, are `./research-report`'s.
 */

import 'server-only'
import type { AuthorizedSession, UserSession } from '@/lib/auth/types'
import { requesterOf } from '@/lib/jobs-queue/types'
import { findProjectIdByCollectionName } from '@/lib/projects/repository'
import { findFiledResearchReport, findReportFilingRefusal, queueResearchReportFiling } from './research-report'

/**
 * What the client is told about the filing, alongside the report itself.
 *
 * Additive: every field the report response already had is untouched, so a
 * client that has never heard of filing keeps working. `documentId` is what the
 * toast's *Öffnen* and *Zuweisen* actions need; `alreadyFiled` distinguishes
 * "this run just produced a document" from "this is the fourth time the tab was
 * opened", which is the difference between showing that toast and not.
 */
interface ReportFilingResult {
  documentId: string
  filename: string
  alreadyFiled: boolean
}

/**
 * What happened to the filing, when something happened at all.
 *
 * ## Why a failure is reported and not just swallowed
 *
 * Filing stays best-effort — the answer is never the filing's to lose, and the
 * `catch` below still swallows the error. What changed is that swallowing it
 * SILENTLY is a broken promise: before the run starts, the banner prints
 * „Der fertige Bericht wird in diesem Projekt unter ‚Berichte' abgelegt."
 * (`deepResearch.starting.filingDisclosure`). A reader who was told that, and
 * is then shown a plain success, goes to Berichte and finds nothing — with
 * nothing anywhere to tell them why, because the only record is a server log
 * they cannot read.
 *
 * `null` used to mean four different things: not a report request, no project
 * to file into, no report yet, and "we tried and it did not work". The first
 * three are states in which no promise was made. Only the fourth is a promise
 * broken, and it is the only one worth a word to the reader.
 *
 * ## Why the reason does not travel
 *
 * A quota refusal, a revoked permission and an object store that is down are
 * one fact to this reader: the document is not there. The differences between
 * them are actionable by an administrator, not by the architect reading a
 * report, and the messages that carry them name buckets, permissions and
 * limits. Those belong in the log, which already has them. A boolean is the
 * whole of what the surface can honestly act on.
 *
 * ## Why `queued` exists (ADR-0079)
 *
 * The PDF is no longer rendered inside this request. A report that is not filed
 * yet is handed to a `file_research_report` job on the `bff-jobs` pool and the
 * answer says so (`filingQueued`): the promise is being kept, not broken, and
 * the document appears in Berichte when the job has run, retried by the queue
 * if it fails. A report that IS filed already answers `filed`, as it always
 * did, from one probe and no render.
 *
 * ## Why `refused` is its own end, and an answer of this request
 *
 * A reader who may not file here (no permission, the feature switched off) used
 * to get a job queued on every read: the job was refused, had no row to say so
 * on and ended cleanly, and the next read queued it again and answered
 * `filingQueued`, for ever. The permission is asked BEFORE queueing now
 * (`findReportFilingRefusal`), so a refusal is what the reader is told
 * (`filingFailed`, the promise broken) and nothing is queued; the reason is in
 * the log. It leaves the same body as `failed`: the reader cannot act on the
 * difference.
 */
export type ReportFilingOutcome =
  | { outcome: 'filed'; filed: ReportFilingResult }
  | { outcome: 'queued' }
  | { outcome: 'refused' }
  | { outcome: 'failed' }

/** The report endpoint's body, as `JobReportResponse` on the backend defines it. */
function readReportMarkdown(data: unknown): string | null {
  if (typeof data !== 'object' || data === null) return null
  const body = data as { has_report?: unknown; report?: unknown }
  if (body.has_report !== true) return null
  return typeof body.report === 'string' && body.report.trim() ? body.report : null
}

/**
 * The collection of the project this run was COMMISSIONED in, off the same body.
 *
 * The backend records it on `job_access` at submit time, from the request that
 * started the run, and returns it beside the report. It is the only statement
 * about the destination that the reader of the report cannot influence.
 */
function readCommissioningCollection(data: unknown): string | null {
  if (typeof data !== 'object' || data === null) return null
  const body = data as { project_collection?: unknown }
  return typeof body.project_collection === 'string' && body.project_collection
    ? body.project_collection
    : null
}

/**
 * The run's cards off the same body, for the filed PDF's „Rechtsgrundlagen".
 *
 * Only shape is checked, not card identity: the backend already validated these
 * at generation (`agent.cards.validate_cards`) and `legalBasisSection`
 * narrows them again at render, so a third opinion here could only reject a
 * card both of those accept. What it does do is refuse a non-array, so a
 * malformed body cannot reach `fileResearchReport` as something to iterate.
 *
 * Absent rather than empty when there is nothing: the section prints no heading
 * at all for an absent value, which is the state a report with no legal basis
 * should reach.
 */
function readReportCards(data: unknown): unknown[] | undefined {
  if (typeof data !== 'object' || data === null) return undefined
  const { cards } = data as { cards?: unknown }
  return Array.isArray(cards) && cards.length > 0 ? cards : undefined
}

/**
 * File a finished run's report into the project, if this is one.
 *
 * ## Why the failure is swallowed
 *
 * The user asked a question and waited minutes for the answer. Filing is a
 * SECOND thing that happens to that answer, and no failure of it — a quota
 * refusal, a revoked permission, an object store that is down — is a reason to
 * throw the answer away. It is logged and surfaced on the response (`filed`
 * absent) rather than raised, which is the same posture every other best-effort
 * enrichment on this route already takes.
 *
 * ## Interactive runs here; scheduled runs at completion
 *
 * A scheduled run (`jobs.schedule_cron`) has no live session and never reaches
 * this handler. It is filed by the worker's outcome callback instead
 * (`/api/internal/jobs/[jobId]/outcome` → `completeTaskForRun`), as the
 * REQUESTER the task row pinned when the job was set up — the person's own
 * membership and permissions resolved at completion (ADR-0051, the design's
 * decision 10). Both paths key the document on the same backend job id, so a
 * report filed at 03:00 and opened here at 09:00 is one row (migration 0064).
 * The session check below stays the anonymous-mode guard, and the rule stays:
 * never a service token — the agent's principal is WIDER than the user's,
 * which is the hole this whole feature was shaped to avoid.
 */
export async function fileCommissionedReport({
  runId,
  session,
  body,
}: {
  /** The backend async job id whose report was read. */
  runId: string
  /** The reader's session; `null` in anonymous mode, which files nothing. */
  session: UserSession | null
  /** The backend's report response, as `JobReportResponse` defines it. */
  body: unknown
}): Promise<ReportFilingOutcome | null> {
  // The reader's project is deliberately NOT a parameter of this function. It
  // used to be, as a precondition — `|| !projectId` — which survived the change
  // that moved the destination onto the run and quietly kept the old coupling:
  // a run commissioned in a project, opened from a context that resolved no
  // project of its own, was never filed, and the response carried neither
  // `filed` nor `filingFailed`, so a reader who had been promised „wird
  // abgelegt" was told nothing at all. Taking the argument away is what stops
  // that being re-introduced by someone reading the precondition as a guard.
  if (!session?.organizationId) return null

  const report = readReportMarkdown(body)
  if (!report) return null

  // WHERE the report goes is a property of the RUN, never of the request that
  // reads it. `projectId` above is whatever the reader's request named, and
  // `buildCollectionScopeFromRequest` fills a missing one in from their stored
  // `active_project_id` — so a run started in a project-less chat (whose banner
  // therefore promised no filing at all) would be filed into whatever project
  // that reader last had open, and an old run reopened while a different
  // project is active would be filed there. Both file a report researched under
  // one Bauordnung carrying a cover sheet that names another one, marked
  // „KI-generiert" and shaped for an Einreichung.
  //
  // So the destination is DERIVED from the run's own `job_access` row and the
  // request's project is not consulted. A run with no commissioning project
  // files nothing: that is the honest reading of „no promise was made", not a
  // licence to pick one.
  const commissioned = readCommissioningCollection(body)
  if (!commissioned) return null
  const commissionedProjectId = await findProjectIdByCollectionName(commissioned, session.organizationId)
  // The collection is real but names no project THIS organization owns. Filing
  // anywhere on that basis would be the cross-tenant version of the bug above.
  if (!commissionedProjectId) return null

  try {
    const filed = await findFiledResearchReport({
      organizationId: session.organizationId,
      projectId: commissionedProjectId,
      runId,
    })
    if (filed) {
      return {
        outcome: 'filed',
        filed: { documentId: filed.documentId, filename: filed.filename, alreadyFiled: true },
      }
    }

    const refusal = await findReportFilingRefusal(session as AuthorizedSession, commissionedProjectId)
    if (refusal) {
      console.warn(`[Deep Research API] the reader may not file the report of run ${runId}: ${refusal}`)
      return { outcome: 'refused' }
    }

    // Narrowed the way every other proxy-layer call to a session-taking service
    // narrows it (`collection-scope-request.ts`): the organization is what makes
    // a session authorized, and it has just been checked. The reader is the
    // requester the job files as (identity and permissions, no access token),
    // exactly as this route used to file in the reader's own session.
    await queueResearchReportFiling({
      organizationId: session.organizationId,
      payload: {
        runId,
        projectId: commissionedProjectId,
        report,
        cards: readReportCards(body),
        taskRunId: null,
        requester: requesterOf(session as AuthorizedSession),
      },
    })
    return { outcome: 'queued' }
  } catch (error) {
    // Logged with the reason, reported without it. The log is where an operator
    // finds the bucket, the permission or the limit; the response carries only
    // what the reader can act on.
    console.error(`[Deep Research API] failed to queue the report's filing:`, error)
    return { outcome: 'failed' }
  }
}
