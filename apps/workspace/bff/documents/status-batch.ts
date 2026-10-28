/**
 * `POST /v1/documents/status/batch` takes at most this many job ids and answers
 * a longer list with a 422 (`BATCH_STATUS_MAX_IDS` in the backend's
 * `routes/documents_jobs.py`; `status-batch-contract.spec.ts` pins the pair).
 *
 * A reader that sent every in-flight job in one call took that 422 for an
 * unreachable backend and left every row alone: a bulk upload of more than
 * this many documents stayed `pending` for good, whatever its jobs had done.
 */
export const BATCH_STATUS_MAX_IDS = 200

/**
 * Ask for `ids` in calls of at most {@link BATCH_STATUS_MAX_IDS}, and merge the answers.
 * `null` when any call could not be answered: the caller then leaves its rows
 * alone for the round, as it did when this was one call.
 */
export async function fetchInChunks<T>(
  ids: string[],
  fetchChunk: (chunk: string[]) => Promise<Record<string, T> | null>
): Promise<Map<string, T> | null> {
  const merged = new Map<string, T>()
  for (let start = 0; start < ids.length; start += BATCH_STATUS_MAX_IDS) {
    const chunk = ids.slice(start, start + BATCH_STATUS_MAX_IDS)
    const answered = await fetchChunk(chunk)
    if (answered === null) {
      console.warn(`[reconcile] job status lookup failed for ${chunk.length} of ${ids.length} job(s); rows left as they are`)
      return null
    }
    for (const [id, status] of Object.entries(answered)) merged.set(id, status)
  }
  return merged
}
