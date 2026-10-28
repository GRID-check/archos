/**
 * GRID job scheduler service.
 *
 * Dedicated container (frontend image, `node scheduler/index.js`) — the exact
 * deployment shape of the purger. Each tick (default 30s) it:
 *   1. claims due `task_definitions` and advances their next_run_at, atomically,
 *      via FOR UPDATE SKIP LOCKED (db.claimDue) — replica- and crash-safe;
 *   2. AFTER that transaction commits, POSTs each claimed definition to the BFF
 *      internal fire endpoint (which records the run row + submits the run);
 *   3. prunes `task_runs` older than the retention window;
 *   4. POSTs the BFF's run reconciler (`/api/internal/runs/reconcile`), which
 *      closes the runs whose ending never reached the BFF by asking the job
 *      store, and settles the block of any closed run that still reads
 *      „läuft" (`lib/runs/reconcile.ts`, backlog T3-11);
 *   5. POSTs the BFF's background-work sweep (`/api/internal/maintenance/
 *      reconcile-background-work`), which gives a document left at `processing`
 *      without a live `bff_job_queue` job a new one, and ends a report filing
 *      left `queued` whose job is gone (`lib/documents/stuck-processing.ts`,
 *      `lib/tasks/filing-sweep.ts`, ADR-0079);
 *   6. POSTs the BFF's upload sweep (`/api/internal/upload-batches/sweep`,
 *      ADR-0086), which settles the uploads whose browser is gone, and its
 *      folder placement sweep (`/api/internal/folder-placement/sweep`,
 *      ADR-0087), which moves a document a backend outage left in the wrong
 *      retrieval collection;
 *   7. once a day, deletes the Langfuse traces older than the retention window
 *      (`sweepTraceRetention`; ADR-0044 — Langfuse's own retention setting is an
 *      Enterprise feature, the delete API is not);
 *   8. every tick, deletes the Langfuse traces of chats the BFF erased in its
 *      delete request, which the purger never sees (`sweepConversationTraces`);
 *   9. once a day, purges the download log past its retention: 12 months at
 *      most, less where an organization chose so, in bounded batches
 *      (`sweepDownloadLogRetention`; migration 0114);
 *  10. once a day, at 06:45 in Vienna (and on the first tick after a start
 *      that comes later in the office's day, to catch that day's run up),
 *      POSTs the BFF's Frist reminder (`/api/internal/annotations/due-reminders`),
 *      which queues one job per organization with marks due today, tomorrow
 *      or in the last week (`sweepAnnotationDue`; `lib/annotations/due-reminders.ts`);
 *  11. every ten minutes, POSTs the BFF's PostHog usage export
 *      (`/api/internal/analytics/usage-export`), which sends the usage ledger's
 *      closed hours and each organization's budget snapshot once an hour
 *      (`sweepUsageExport`; `lib/analytics/usage-export.ts`).
 * See ADR-0046 and docs/architecture/agent-skills.md ("Scheduler worker").
 *
 * Environment:
 *   APP_DATABASE_URL              - `app` Postgres DSN (required)
 *   FRONTEND_INTERNAL_URL              - BFF base URL (default http://frontend:3000)
 *   INTERNAL_API_TOKEN            - shared token for the internal fire endpoint
 *   SKILL_SCHEDULER_POLL_MS       - tick interval (default 30000)
 *   SKILL_SCHEDULER_BATCH         - max claims per tick (default 20)
 *   SKILL_RUNS_RETENTION_DAYS     - run-history retention (default 90)
 *   LANGFUSE_HOST / LANGFUSE_PUBLIC_KEY / LANGFUSE_SECRET_KEY
 *                                      - Langfuse API for the trace retention
 *                                        sweep (all three, or it is a no-op)
 *   TRACE_RETENTION_DAYS - how long Langfuse traces live
 *                                        (default 30, minimum 3)
 *
 * There is no deployment-wide schedules gate. Every due definition is claimed
 * and handed to the BFF, which checks the organization's `skills` WorkOS flag
 * and records a `skipped` run when it is off (`fireScheduledJob`,
 * `bff/jobs/service.ts`). That is the same per-organization answer the
 * Automation section reads, so revoking an organization's flag pauses its
 * schedules without a deploy, and nothing here can disagree with it.
 */

const { createSql } = require('../workers/app-database')
const {
  claimDue,
  pruneOldRuns,
  findConversationsAwaitingTraceErasure,
  conversationIsHeld,
  markConversationTracesErased,
  pruneDownloadLog,
} = require('./db')
const { nextOccurrence } = require('./cron')
const { initOtelLogs } = require('../observability/otel-logs')
const { initOtelMetrics } = require('../observability/otel-metrics')
const {
  LangfuseError,
  createTraceClient,
  deleteTracesBefore,
  eraseSessionTraces,
  readLangfuseConfig,
  readTraceRetentionDays,
} = require('../workers/langfuse-traces')
const {
  createFailureStreak,
  databaseOutage,
  describeFailedResponse,
  describeTransportError,
  escalationTicks,
  isTransientStatus,
} = require('../workers/failure-streak')

const LOG = '[job-scheduler]'

// Must match bff/internal-auth.ts INTERNAL_TOKEN_HEADER — the header the
// `internalApiRoute` factory guarding /api/internal/skills/fire expects.
const INTERNAL_TOKEN_HEADER = 'x-internal-token'
const FIRE_TIMEOUT_MS = 30000
// One sweep claims at most 25 runs and asks the backend about 5 at a time, each
// with a 10 s timeout: about a minute in the worst case. The reentrancy guard in
// main() keeps a slow sweep from overlapping the next tick.
const RECONCILE_TIMEOUT_MS = 120000

function toPositiveInt(raw, fallback) {
  const n = parseInt(raw, 10)
  return Number.isFinite(n) && n > 0 ? n : fallback
}

function readConfig(env) {
  const langfuse = readLangfuseConfig(env)
  const traceRetention = readTraceRetentionDays(env)
  return {
    langfuse: langfuse.config,
    langfuseMissing: langfuse.missing,
    traceRetentionDays: traceRetention.days,
    traceRetentionClamped: traceRetention.clamped,
    frontendUrl: (env.FRONTEND_INTERNAL_URL || 'http://frontend:3000').replace(/\/$/, ''),
    internalToken: env.INTERNAL_API_TOKEN || '',
    pollMs: toPositiveInt(env.SKILL_SCHEDULER_POLL_MS, 30000),
    batch: toPositiveInt(env.SKILL_SCHEDULER_BATCH, 20),
    retentionDays: toPositiveInt(env.SKILL_RUNS_RETENTION_DAYS, 90),
  }
}

/**
 * The streaks the tick loop keeps between ticks (`workers/failure-streak.js`):
 * the reconcile POST, and the database work behind firing (claim and prune).
 * A transient failure of either is a WARN until it has lasted about five
 * minutes, which logs one ERROR, and the first success after logs a recovery.
 */
function createStreaks(config) {
  const escalateAfter = escalationTicks(config.pollMs)
  return {
    reconcile: createFailureStreak({ label: `${LOG} run reconcile`, escalateAfter }),
    background: createFailureStreak({ label: `${LOG} background work sweep`, escalateAfter }),
    uploads: createFailureStreak({ label: `${LOG} upload sweep`, escalateAfter }),
    placement: createFailureStreak({ label: `${LOG} folder placement sweep`, escalateAfter }),
    database: createFailureStreak({ label: `${LOG} schedule claim`, escalateAfter }),
    // Counts failed ATTEMPTS, one an hour at most (`TRACE_RETENTION_RETRY_MS`),
    // not ticks: three in a row is about three hours of Langfuse being wrong.
    traceRetention: createFailureStreak({ label: `${LOG} trace retention`, escalateAfter: 3 }),
    // When the retention sweep may next run. Lives with the streaks because both
    // must outlive the tick; a fresh one per tick would sweep on every tick.
    traceRetentionClock: { nextRunAt: 0 },
    conversationTraces: createFailureStreak({ label: `${LOG} conversation trace erasure`, escalateAfter }),
    // Backoff after a failure that is not transient: a 401 or a poisoned row
    // would otherwise log an ERROR on every tick.
    conversationTracesClock: { nextRunAt: 0 },
    // Daily, like the trace retention; its clock lives here for the same reason.
    downloadLog: createFailureStreak({ label: `${LOG} download log retention`, escalateAfter }),
    downloadLogClock: { nextRunAt: 0 },
    // Daily at a set hour of the office's morning; its clock outlives the tick too.
    annotationDue: createFailureStreak({ label: `${LOG} Frist reminder`, escalateAfter: 3 }),
    annotationDueClock: { nextRunAt: 0 },
    // Every ten minutes; the BFF's cursor decides what is due, this only paces the asking.
    usageExport: createFailureStreak({ label: `${LOG} PostHog usage export`, escalateAfter: 3 }),
    usageExportClock: { nextRunAt: 0 },
  }
}

/**
 * One run-reconciler sweep: POST {frontendUrl}/api/internal/runs/reconcile.
 *
 * The BFF does the work — it owns the run lifecycle, and closing a run through
 * any path but its outcome service would be a second author of the row. This
 * container only supplies the clock, as it does for firing. The sweep is
 * replica-safe on the BFF side (the claim stamps each run it takes), so running
 * this from every scheduler replica is fine. Logs only when it changed
 * something or failed; never throws. Returns the sweep's counts, or null.
 *
 * A transport error, or a 404/502/503/504 (a rollout's old frontend pod, the
 * BFF answering a database outage), goes to `streak` as transient. Any other
 * status is a real fault and logs at ERROR at once. No failure logs an HTML
 * body (`describeFailedResponse`).
 */
async function reconcileRuns(config, fetchImpl, streak) {
  const counts = await postSweep(config, fetchImpl, streak, {
    path: '/api/internal/runs/reconcile',
    label: 'run reconcile',
  })
  if (counts && (counts.closed > 0 || counts.healed > 0 || counts.failed > 0)) {
    console.log(
      `${LOG} run reconcile: checked ${counts.checked}, closed ${counts.closed}, ` +
        `already closed ${counts.alreadyClosed}, waiting ${counts.waiting}, ` +
        `healed ${counts.healed ?? 0}, failed ${counts.failed}`,
    )
  }
  return counts
}

/**
 * One background-work sweep: POST {frontendUrl}/api/internal/maintenance/
 * reconcile-background-work. Same contract as {@link reconcileRuns}: the BFF
 * owns the work (a stranded document gets a new `bff_job_queue` job or says why
 * it cannot; a report filing whose job is gone is ended), this container
 * supplies the clock. Logs only when it changed something or failed; never
 * throws. Returns the counts `{ documents, filings }`, or null.
 */
async function reconcileBackgroundWork(config, fetchImpl, streak) {
  const counts = await postSweep(config, fetchImpl, streak, {
    path: '/api/internal/maintenance/reconcile-background-work',
    label: 'background work sweep',
  })
  const documents = counts?.documents
  const filings = counts?.filings
  if (documents && (documents.requeued > 0 || documents.failed > 0 || documents.errors > 0)) {
    console.log(
      `${LOG} background work sweep, documents: checked ${documents.checked}, requeued ${documents.requeued}, ` +
        `failed ${documents.failed}, gone ${documents.gone}, errors ${documents.errors}`,
    )
  }
  if (filings && (filings.filed > 0 || filings.failed > 0 || filings.errors > 0)) {
    console.log(
      `${LOG} background work sweep, report filings: checked ${filings.checked}, filed ${filings.filed}, ` +
        `failed ${filings.failed}, waiting ${filings.waiting}, errors ${filings.errors}`,
    )
  }
  return counts
}

/**
 * One upload sweep: POST {frontendUrl}/api/internal/upload-batches/sweep
 * (ADR-0086). Settles the uploads whose browser is gone, so their uploader is
 * told when everything was read, and sends the content gate's quarantine
 * decisions still owed to the audit trail. Same posture as the run reconciler:
 * the BFF does the work, this container supplies the clock, nothing throws,
 * and it logs only when it settled or sent something, or failed.
 */
async function sweepUploads(config, fetchImpl, streak) {
  const counts = await postSweep(config, fetchImpl, streak, {
    path: '/api/internal/upload-batches/sweep',
    label: 'upload sweep',
  })
  // An older BFF does not report `audited`.
  const audited = counts?.audited ?? 0
  if (counts && (counts.sealed > 0 || counts.completed > 0 || counts.failed > 0 || audited > 0)) {
    console.log(
      `${LOG} upload sweep: checked ${counts.checked}, sealed ${counts.sealed}, ` +
        `completed ${counts.completed}, failed ${counts.failed}, quarantines audited ${audited}`,
    )
  }
  return counts
}

/**
 * Move the documents a backend outage left in the wrong retrieval collection
 * (ADR-0087): a document under a restricted folder whose chunks could not be
 * purged from the project's open collection is still findable there until it
 * is placed again.
 */
async function sweepPlacement(config, fetchImpl, streak) {
  const counts = await postSweep(config, fetchImpl, streak, {
    path: '/api/internal/folder-placement/sweep',
    label: 'folder placement sweep',
  })
  if (counts && (counts.moved > 0 || counts.pending > 0 || counts.failed > 0)) {
    console.log(
      `${LOG} folder placement sweep: checked ${counts.checked}, moved ${counts.moved}, ` +
        `still pending ${counts.pending}, failed ${counts.failed}`,
    )
  }
  return counts
}

const DAY_MS = 24 * 60 * 60 * 1000
/** Between a sweep's finish and the next: it is a daily job. */
const TRACE_RETENTION_INTERVAL_MS = DAY_MS
/** After a failed sweep. Not the 30 s tick: Langfuse is down or wrong, and a retry storm helps neither. */
const TRACE_RETENTION_RETRY_MS = 60 * 60 * 1000

/**
 * The Langfuse trace retention sweep: delete the traces older than
 * `traceRetentionDays`, at most `DEFAULT_MAX_BATCHES` delete requests per run
 * (`workers/langfuse-traces.js`), so a backlog drains over days. Runs once a day
 * counted from the previous run, the first one on the first tick after the
 * process starts; every replica running it is harmless, the deletes repeat
 * safely. Not configured is a no-op (the boot line says so) and never throws:
 * a Langfuse that is down delays the sweep, and a failed one retries in an hour.
 *
 * A transient failure (transport, timeout, 429, 5xx) goes to `streak` as WARN
 * and escalates to one ERROR after three attempts in a row; any other
 * (a 401, a 404 from a Langfuse not in a v4 write mode, a filter Langfuse
 * ignored) is a real fault and logs at ERROR at once, with no ids and no body.
 * Returns the counts of a run that happened, or null.
 */
async function sweepTraceRetention(config, fetchImpl, streak, clock, now = new Date()) {
  if (!config.langfuse || now.getTime() < clock.nextRunAt) return null
  const cutoff = new Date(now.getTime() - config.traceRetentionDays * DAY_MS)
  try {
    const client = createTraceClient(config.langfuse, fetchImpl)
    const result = await deleteTracesBefore(client, cutoff)
    clock.nextRunAt = now.getTime() + TRACE_RETENTION_INTERVAL_MS
    streak.succeeded()
    console.log(
      `${LOG} trace retention: asked Langfuse to delete ${result.traces} trace(s) older than ` +
        `${config.traceRetentionDays} days (before ${cutoff.toISOString()}) in ${result.batches} batch(es)` +
        (result.capped ? '; more remain, the next run continues' : ''),
    )
    return result
  } catch (error) {
    clock.nextRunAt = now.getTime() + TRACE_RETENTION_RETRY_MS
    if (error instanceof LangfuseError && error.transient) {
      streak.failed({ kind: error.kind, detail: error.message })
    } else {
      const kind = error instanceof LangfuseError ? error.kind : 'unexpected error'
      console.error(`${LOG} trace retention failed: ${kind} (${error instanceof Error ? error.message : error})`)
    }
    return null
  }
}

/** The BFF-erased chats handled in one run, and how long a run may take. */
const CONVERSATION_TRACES_PER_RUN = 100
const CONVERSATION_TRACES_BUDGET_MS = 120_000
/** After a failure that is not transient. A transient one retries on the next tick. */
const CONVERSATION_TRACES_BACKOFF_MS = 60 * 60 * 1000

const conversationTraceStore = {
  candidates: findConversationsAwaitingTraceErasure,
  held: conversationIsHeld,
  markErased: markConversationTracesErased,
}

/**
 * Erase the Langfuse traces of chats the BFF erased in the delete request.
 *
 * `DELETE /api/conversations/[id]` erases in the BFF and closes its queue row
 * as 'purged', and the purger never runs for it, so nothing deleted the chat's
 * traces. This finds those rows (`findConversationsAwaitingTraceErasure`: erased
 * within 35 days, at least 15 minutes ago, not yet stamped, not under a legal
 * hold), deletes each chat's traces with the client the purger uses, and stamps
 * `payload.langfuseTracesErasedAt` so it is done once. The hold is asked again
 * right before each deletion.
 *
 * Not configured is a no-op (the boot line says so). A transient failure
 * (transport, timeout, 429, 5xx) stops the run and retries on the next tick,
 * going to `streak` as a WARN that escalates to one ERROR; any other failure
 * logs ERROR with no ids and no body and backs off for an hour. A run handles at
 * most `CONVERSATION_TRACES_PER_RUN` chats in two minutes. Never throws.
 * Returns the number erased, or null when it did not run.
 */
async function sweepConversationTraces(
  sql,
  config,
  fetchImpl,
  streak,
  clock,
  now = new Date(),
  store = conversationTraceStore,
) {
  if (!config.langfuse || now.getTime() < clock.nextRunAt) return null
  const startedMs = Date.now()
  let erased = 0
  try {
    const rows = await store.candidates(sql, CONVERSATION_TRACES_PER_RUN)
    const client = createTraceClient(config.langfuse, fetchImpl)
    for (const row of rows) {
      if (Date.now() - startedMs >= CONVERSATION_TRACES_BUDGET_MS) break
      if (await store.held(sql, row)) continue
      await eraseSessionTraces(client, row.entity_id)
      await store.markErased(sql, row.id)
      erased += 1
    }
    streak.succeeded()
    if (erased > 0) console.log(`${LOG} conversation trace erasure: asked Langfuse to delete the traces of ${erased} erased chat(s)`)
    return erased
  } catch (error) {
    const outage = databaseOutage(error)
    if (outage) {
      streak.failed(outage)
    } else if (error instanceof LangfuseError && error.transient) {
      streak.failed({ kind: error.kind, detail: error.message })
    } else {
      clock.nextRunAt = now.getTime() + CONVERSATION_TRACES_BACKOFF_MS
      const kind = error instanceof LangfuseError ? error.kind : 'unexpected error'
      console.error(`${LOG} conversation trace erasure failed: ${kind} (${error instanceof Error ? error.message : error})`)
    }
    return erased > 0 ? erased : null
  }
}

/** After a failure of the download log sweep that is not a database outage. */
const DOWNLOAD_LOG_BACKOFF_MS = 60 * 60 * 1000

/**
 * The download log's retention sweep (migration 0114): purge entries past their
 * retention, once a day counted from the previous run, the first on the first
 * tick after the process starts. A run deletes at most 50 batches of 1000
 * (`pruneDownloadLog`); when it stopped on that budget with more behind it, the
 * next tick continues, and the 24 hours start when a run finds nothing left to
 * cap on. Every replica running it is harmless: the deletes repeat safely.
 *
 * A database outage goes to `streak` as a WARN that escalates; any other failure
 * logs ERROR and waits an hour. Never throws. Returns the counts of a run that
 * happened, or null.
 */
async function sweepDownloadLogRetention(sql, streak, clock, now = new Date(), prune = pruneDownloadLog) {
  if (now.getTime() < clock.nextRunAt) return null
  try {
    const result = await prune(sql)
    clock.nextRunAt = result.capped ? now.getTime() : now.getTime() + DAY_MS
    streak.succeeded()
    if (result.deleted > 0) {
      console.log(
        `${LOG} download log retention: deleted ${result.deleted} entr${result.deleted === 1 ? 'y' : 'ies'} past retention` +
          (result.capped ? '; more remain, the next tick continues' : ''),
      )
    }
    return result
  } catch (error) {
    const outage = databaseOutage(error)
    if (outage) {
      streak.failed(outage)
    } else {
      clock.nextRunAt = now.getTime() + DOWNLOAD_LOG_BACKOFF_MS
      console.error(`${LOG} download log retention failed:`, error)
    }
    return null
  }
}

/** When the Frist reminder runs: before the office's day starts, so the inbox has it at the first look. */
const ANNOTATION_DUE_CRON = '45 6 * * *'
const OFFICE_TIME_ZONE = 'Europe/Vienna'
/** After a failed post. Not the 30 s tick: the BFF is down or wrong, and a day's reminder can wait an hour. */
const ANNOTATION_DUE_RETRY_MS = 60 * 60 * 1000

/** The calendar day of `date` in the office's time zone, `YYYY-MM-DD`. */
const officeDayOf = (date) => new Intl.DateTimeFormat('en-CA', { timeZone: OFFICE_TIME_ZONE }).format(date)

/**
 * The daily Frist reminder: POST {frontendUrl}/api/internal/annotations/due-reminders.
 * The BFF queues one job per organization whose marks have a Zuständige and a
 * Frist today, tomorrow or within the overdue window; the job reminds each of
 * them once per reminder and date. Every day at 06:45 in Vienna. A start
 * before 06:45 waits for it: a restart at 01:00 would otherwise push and mail
 * at 01:00, and its stamps would silence the 06:45 run. A start later in the
 * day catches that day's run up at once; when it already ran, the job's stamps
 * tell nobody twice. A failed post retries in an hour, but never past the
 * office's midnight: then it waits for the next 06:45. Never throws; logs only
 * what it queued or a failure. Returns the counts, or null when it did not run.
 */
async function sweepAnnotationDue(config, fetchImpl, streak, clock, now = new Date()) {
  if (clock.nextRunAt === 0) {
    const next = nextOccurrence(ANNOTATION_DUE_CRON, OFFICE_TIME_ZONE, now)
    // Today's run is still ahead: wait for it rather than run at whatever hour this started.
    if (officeDayOf(next) === officeDayOf(now)) {
      clock.nextRunAt = next.getTime()
      return null
    }
  }
  if (now.getTime() < clock.nextRunAt) return null
  const counts = await postSweep(config, fetchImpl, streak, {
    path: '/api/internal/annotations/due-reminders',
    label: 'Frist reminder',
  })
  if (!counts) {
    // A retry stays on the office's day: one past midnight would remind the next day at night, and its stamps would silence 06:45.
    const retry = new Date(now.getTime() + ANNOTATION_DUE_RETRY_MS)
    clock.nextRunAt =
      officeDayOf(retry) === officeDayOf(now)
        ? retry.getTime()
        : nextOccurrence(ANNOTATION_DUE_CRON, OFFICE_TIME_ZONE, now).getTime()
    return null
  }
  clock.nextRunAt = nextOccurrence(ANNOTATION_DUE_CRON, OFFICE_TIME_ZONE, now).getTime()
  if (counts.queued > 0) {
    console.log(
      `${LOG} Frist reminder for ${counts.day}: ${counts.organizations} organization(s) with marks due, ` +
        `${counts.queued} job(s) queued, ${counts.already} already queued`,
    )
  }
  return counts
}

/** Between two asks of the usage export. The BFF sends an hour once, so asking more often only reads a cursor. */
const USAGE_EXPORT_INTERVAL_MS = 10 * 60 * 1000

/**
 * The PostHog usage export: POST {frontendUrl}/api/internal/analytics/usage-export
 * every ten minutes, the first on the first tick. The BFF keeps the cursor, so
 * this only paces it: a restart, a second replica or a failed post costs a
 * repeated ask, never a repeated hour. While the backfill runs, each ask sends
 * the next window and the next ask follows at once (`caughtUp` false). Never
 * throws; logs what it sent. Returns the counts, or null when it did not run.
 */
async function sweepUsageExport(config, fetchImpl, streak, clock, now = new Date()) {
  if (now.getTime() < clock.nextRunAt) return null
  const counts = await postSweep(config, fetchImpl, streak, {
    path: '/api/internal/analytics/usage-export',
    label: 'PostHog usage export',
  })
  const behind = Boolean(counts && counts.usage && counts.usage.caughtUp === false)
  clock.nextRunAt = behind ? now.getTime() : now.getTime() + USAGE_EXPORT_INTERVAL_MS
  if (counts && counts.usage) {
    console.log(
      `${LOG} PostHog usage export: ${counts.usage.rows} hourly row(s) from ${counts.usage.from} to ${counts.usage.to}` +
        (behind ? '; more history behind it, the next tick continues' : ''),
    )
  }
  if (counts && counts.snapshot) {
    console.log(
      `${LOG} PostHog budget snapshot for ${counts.snapshot.hour}: ${counts.snapshot.organizations} organization(s)`,
    )
  }
  return counts
}

/**
 * POST one of the BFF's internal sweeps and read its counts.
 *
 * A transport error, or a 404/502/503/504 (a rollout's old frontend pod, the
 * BFF answering a database outage), goes to `streak` as transient. Any other
 * status is a real fault and logs at ERROR at once. No failure logs an HTML
 * body (`describeFailedResponse`). Returns the counts, or null.
 */
async function postSweep(config, fetchImpl, streak, { path, label }) {
  const url = `${config.frontendUrl}${path}`
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), RECONCILE_TIMEOUT_MS)
  try {
    const res = await fetchImpl(url, {
      method: 'POST',
      headers: { [INTERNAL_TOKEN_HEADER]: config.internalToken },
      signal: controller.signal,
    })
    if (!res.ok) {
      const failure = await describeFailedResponse(res)
      if (isTransientStatus(res.status)) {
        streak.failed(failure)
      } else {
        console.error(`${LOG} ${label} failed: ${failure.detail}`)
      }
      return null
    }
    streak.succeeded()
    try {
      return await res.json()
    } catch {
      /* non-JSON 200 — nothing to report */
      return null
    }
  } catch (error) {
    streak.failed(describeTransportError(error))
    return null
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Fire one claimed definition: POST {frontendUrl}/api/internal/skills/fire with
 * the shared internal token and body {scheduleId} (the pre-jobs wire spelling,
 * kept because this container and the BFF deploy separately — see the route).
 * It names a `task_definitions.id`; the id space is the same one jobs used,
 * because 0086 reuses job ids for their definitions. Non-2xx and transport
 * errors are logged loudly and swallowed (returns false) — a fire failure must
 * never throw out of the tick loop. They stay ERROR even when transient, unlike
 * the reconcile POST's: a failed fire is an occurrence somebody scheduled that
 * did not run, and no later tick brings it back. The BFF records run rows; if
 * the BFF itself was unreachable the occurrence is missed-once and the next
 * occurrence heals it (ADR-0023 risks). A ~30s AbortController timeout bounds
 * each request. No failure logs an HTML body (`describeFailedResponse`).
 */
async function fireOne(config, scheduleId, fetchImpl = fetch) {
  const url = `${config.frontendUrl}/api/internal/skills/fire`
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), FIRE_TIMEOUT_MS)
  try {
    const res = await fetchImpl(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        [INTERNAL_TOKEN_HEADER]: config.internalToken,
      },
      body: JSON.stringify({ scheduleId }),
      signal: controller.signal,
    })
    if (!res.ok) {
      const { detail } = await describeFailedResponse(res)
      console.error(`${LOG} fire failed for job ${scheduleId}: ${detail}`)
      return false
    }
    // A 200 is not always a fire: the BFF returns {fired:false, reason} for
    // disabled/feature-gated rows. Log skips as skips so operators see them.
    let outcome = null
    try {
      outcome = await res.json()
    } catch {
      /* non-JSON 200 — treat as fired, the BFF contract says it is */
    }
    if (outcome && outcome.fired === false) {
      console.warn(`${LOG} job ${scheduleId} not fired: ${outcome.reason || 'unknown reason'}`)
      return false
    }
    console.log(`${LOG} fired job ${scheduleId}`)
    return true
  } catch (error) {
    console.error(
      `${LOG} fire request errored for job ${scheduleId}:`,
      error && error.message ? error.message : error,
    )
    return false
  } finally {
    clearTimeout(timer)
  }
}

/**
 * One scheduler tick: the schedules, then the run reconciler and the
 * background-work sweeps. None of them can throw out of the tick. Returns the count
 * fired (for logs). `streaks` must outlive the tick (`createStreaks`): a fresh
 * one per tick would never reach its escalation.
 */
async function tick(sql, config, fetchImpl, streaks) {
  const fired = await fireDue(sql, config, streaks.database)
  await reconcileRuns(config, fetchImpl, streaks.reconcile)
  await reconcileBackgroundWork(config, fetchImpl, streaks.background)
  await sweepUploads(config, fetchImpl, streaks.uploads)
  await sweepPlacement(config, fetchImpl, streaks.placement)
  await sweepTraceRetention(config, fetchImpl, streaks.traceRetention, streaks.traceRetentionClock)
  await sweepConversationTraces(sql, config, fetchImpl, streaks.conversationTraces, streaks.conversationTracesClock)
  await sweepDownloadLogRetention(sql, streaks.downloadLog, streaks.downloadLogClock)
  await sweepAnnotationDue(config, fetchImpl, streaks.annotationDue, streaks.annotationDueClock)
  await sweepUsageExport(config, fetchImpl, streaks.usageExport, streaks.usageExportClock)
  return fired
}

/**
 * Claim + advance (atomic), then fire the claimed rows concurrently
 * (batch <= 20), then prune. Every stage is defended so nothing throws — a
 * failed claim skips this tick's fires, a failed fire is logged, a failed prune
 * is logged. Returns the count fired.
 *
 * The claim is one transaction, so a claim that fails with the database
 * unavailable has claimed nothing and advanced nothing: the rows are still due
 * and the next tick fires them. That is a transient failure for `streak`. Any
 * other claim or prune error is a real fault, logged at ERROR.
 */
async function fireDue(sql, config, streak) {
  let claimed = []
  try {
    claimed = await claimDue(sql, config.batch, (cron, tz) => nextOccurrence(cron, tz, new Date()))
  } catch (error) {
    const outage = databaseOutage(error)
    if (outage) streak.failed(outage)
    else console.error(`${LOG} claim transaction failed — skipping fires this tick:`, error)
    return 0
  }

  // Fire the batch concurrently: schedules cluster on popular cron slots
  // (daily-at-9 etc.), and sequential 30s-timeout fires would let one slow
  // BFF hop stall the whole tick (batch × timeout ≫ poll interval). fireOne
  // never rejects, so allSettled is belt-and-braces.
  const results = await Promise.allSettled(claimed.map((row) => fireOne(config, row.id)))
  const fired = results.filter((r) => r.status === 'fulfilled' && r.value === true).length

  try {
    const pruned = await pruneOldRuns(sql, config.retentionDays)
    if (pruned > 0) {
      console.log(`${LOG} pruned ${pruned} task_runs older than ${config.retentionDays} days`)
    }
    streak.succeeded()
  } catch (error) {
    // Retention is idempotent: an outage here only defers it to a later tick.
    const outage = databaseOutage(error)
    if (outage) streak.failed(outage)
    else console.error(`${LOG} run-history prune failed:`, error)
  }

  return fired
}

function main() {
  // No-op without OTEL_EXPORTER_OTLP_ENDPOINT (ADR-0029 capability gate).
  initOtelLogs()
  initOtelMetrics()
  const config = readConfig(process.env)
  const sql = createSql()
  const streaks = createStreaks(config)

  // Reentrancy guard, exactly like purger/index.js: a slow tick (many fires,
  // a slow prune) must never overlap the next interval firing.
  let running = false
  const runTick = async () => {
    if (running) return
    running = true
    try {
      await tick(sql, config, fetch, streaks)
    } catch (error) {
      console.error(`${LOG} unexpected tick error:`, error)
    } finally {
      running = false
    }
  }

  console.log(
    `${LOG} started, polling every ${config.pollMs}ms ` +
      `(batch ${config.batch}, retention ${config.retentionDays}d, target ${config.frontendUrl})`,
  )
  console.log(
    `${LOG} Langfuse trace erasure of deleted chats and retention: ` +
      (config.langfuse
        ? `${config.traceRetentionDays} days${config.traceRetentionClamped ? ' (TRACE_RETENTION_DAYS is below the minimum of 3 or invalid, corrected)' : ''}`
        : `off (missing ${config.langfuseMissing.join(', ')})`),
  )
  void runTick()
  setInterval(() => void runTick(), config.pollMs)
}

if (require.main === module) {
  main()
}

module.exports = {
  readConfig,
  toPositiveInt,
  createStreaks,
  fireOne,
  reconcileRuns,
  reconcileBackgroundWork,
  sweepUploads,
  sweepPlacement,
  sweepTraceRetention,
  sweepConversationTraces,
  sweepDownloadLogRetention,
  sweepAnnotationDue,
  sweepUsageExport,
  tick,
  INTERNAL_TOKEN_HEADER,
}
