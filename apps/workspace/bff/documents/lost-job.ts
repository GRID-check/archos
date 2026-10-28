import type { ReconcilableDocument, TerminalResolution } from './reconcile-status'

/**
 * The reason prefix the backend gives a job whose owner stopped heartbeating
 * (`INTERRUPTED` in `agent/knowledge/ingest_status_store.py`). Such a
 * failure is a verdict another replica reached about someone else's job, and
 * the owner may still be alive: when it writes again its write wins, and the
 * job can end `completed` with its chunks indexed. A row the BFF already moved
 * to `failed` from that verdict is therefore asked about again.
 */
export const INTERRUPTED_REASON_PREFIX = 'interrupted:'

/**
 * How long after the row's last write an `interrupted:` failure is re-checked.
 * An owner that revives does so within a heartbeat of reaching the database
 * again; half an hour covers a long outage and then stops, so a job that
 * really died costs a bounded number of batch lookups rather than one per read
 * for as long as the row exists.
 */
const INTERRUPTED_RECHECK_WINDOW_MS = 30 * 60 * 1000

/**
 * How long a dispatched row may wait before a job the backend no longer knows is
 * given up. The backend keeps a finished job's status 24 hours
 * (`FILE_TRACKING_RETENTION_SECONDS`) and never prunes one a queue row still holds,
 * so a job it has no record of two days on is gone, not slow.
 */
const LOST_JOB_AFTER_MS = 48 * 60 * 60 * 1000

export const extractIngestJobId = (metadata: unknown): string | null => {
  if (metadata && typeof metadata === 'object' && 'ingestJobId' in metadata) {
    const jobId = (metadata as Record<string, unknown>).ingestJobId
    if (typeof jobId === 'string' && jobId.length > 0) return jobId
  }
  return null
}

export const toEpochMs = (value: Date | string | null | undefined): number | null => {
  if (value === null || value === undefined) return null
  const ms = new Date(value).getTime()
  return Number.isNaN(ms) ? null : ms
}

/**
 * A row still `pending` long after its dispatch whose job the backend has
 * forgotten. The caller has also found no indexed file under its name, so nothing
 * is left that could say what happened: a bulk upload's jobs that failed on the
 * 19th were pruned on the 20th, and their rows read `pending` for ever. A row
 * without `updatedAt` is never lost: nothing would say how old it is.
 */
export const isLostJob = (row: ReconcilableDocument, now: number): boolean => {
  const writtenAt = toEpochMs(row.updatedAt)
  return writtenAt !== null && now - writtenAt > LOST_JOB_AFTER_MS
}

/**
 * The failure a lost job leaves: the backend's own `interrupted:` wording and its
 * category (`transient`, retryable), so the retry rule and the UI treat it like
 * any job whose owner went away. The real reason is not retained anywhere.
 */
export const lostJobResolution = (): TerminalResolution => ({
  status: 'failed',
  errorMessage: `${INTERRUPTED_REASON_PREFIX} the ingestion job was lost before it finished; retry to index this file`,
  failure: { category: 'transient', retryable: true, readerVersion: null },
})

/**
 * A `failed` row whose failure was the backend's `interrupted` settle, recent
 * enough to still be worth asking about, and with a job the batch call can
 * answer for. See {@link INTERRUPTED_REASON_PREFIX}. A row without `updatedAt`
 * is not re-checked: nothing would bound how long it keeps asking.
 */
export const isRecheckableInterruption = (row: ReconcilableDocument, now: number): boolean => {
  if (row.status !== 'failed') return false
  if (!row.errorMessage?.startsWith(INTERRUPTED_REASON_PREFIX)) return false
  if (!extractIngestJobId(row.metadata)) return false
  const writtenAt = toEpochMs(row.updatedAt)
  return writtenAt !== null && now - writtenAt < INTERRUPTED_RECHECK_WINDOW_MS
}

/**
 * A `cancelled` row recent enough to still be worth asking about, and with a
 * job the batch call can answer for.
 *
 * A cancel and a job finalizing can land in the same instant: a worker that
 * passed its last ownership check may finish and write `completed` just as the
 * queue records the stop. The stop is the trace then, not the truth, and a row
 * the BFF wrote `cancelled` is asked about again for the same bounded window as
 * an interruption — a late `completed` heals it. The status alone is the
 * marker, so no message prefix is needed. A row without `updatedAt` is not
 * re-checked: nothing would bound how long it keeps asking.
 */
export const isRecheckableCancellation = (row: ReconcilableDocument, now: number): boolean => {
  if (row.status !== 'cancelled') return false
  if (!extractIngestJobId(row.metadata)) return false
  const writtenAt = toEpochMs(row.updatedAt)
  return writtenAt !== null && now - writtenAt < INTERRUPTED_RECHECK_WINDOW_MS
}
