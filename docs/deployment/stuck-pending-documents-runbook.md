# Documents stuck at `pending` after a bulk upload

**Symptom.** One upload batch of more than 200 documents shows every document as
`pending` for days, although `ingest-worker` is healthy. In the app database each
row has `ingest_attempts = 1`, an empty `ingest_failure_category`, and an
`updated_at` equal to its upload time. `ingest_job_queue` in the jobs database
holds nothing for them, and the batch has `sealed_at` set and `completed_at` empty.

**Cause.** The reconciler asked the backend for the status of every in-flight job
in one call, and `POST /v1/documents/status/batch` refuses more than 200 ids with
a 422. The BFF read the refusal as an unreachable backend and left every row
alone, on every read and every sweep. The jobs themselves had run, and a finished
job's queue row is deleted, so the queue looked empty. The fix sends the ids in
calls of at most 200 (`apps/workspace/bff/documents/status-batch.ts`). See the
[gotchas entry](../contributing/gotchas.md) for how it was found.

Nothing here re-ingests anything. The documents are read back from what the backend
already knows, so the steps are safe to repeat.

## 1. Deploy the fix first

The catch-up below runs the fixed code. Run it against a BFF that predates the fix
and it fails the same way.

## 2. Run the catch-up sweep (the owner runs this; it writes document status)

The upload sweep settles open batches, and by default only those created in the last
7 days. `?windowDays=N` (1 to 60) widens the look-back for this one run, so a batch
that aged out while stuck is included. The scheduler never sends it.

```bash
kubectl -n grid exec deploy/frontend -c frontend -- node -e '
fetch("http://localhost:3000/api/internal/upload-batches/sweep?windowDays=30", {
  method: "POST",
  headers: { "x-internal-token": process.env.INTERNAL_API_TOKEN },
}).then(async (r) => console.log(r.status, await r.text()))'
```

The token header is `x-internal-token`. The receivers still accept the old
`x-grid-internal-token` until the cleanup release, so the command works on
either side of the header rename; swap the name if a pod runs a build that
predates it.

The answer is the sweep's counts: `checked`, `sealed`, `completed`, `failed`. One call
handles the 25 newest open batches in the window; repeat it until `checked` stops
shrinking. It is idempotent: every status write is guarded by the status it read, a
batch is completed once, and a settled document is never touched again.

## 3. Check the result (read-only)

```sql
-- app database
SELECT status, count(*) FROM documents
WHERE organization_id = '<organization id>' AND upload_batch_id IN ('<batch id>', '<batch id>')
GROUP BY status;
```

`pending` should be gone, replaced by `completed` or `failed` with a reason.

## 4. What can stay `pending`

A document whose job the backend has forgotten (its status row was pruned) and whose
file is not in the collection listing stays `pending`: no witness is left for it.
Re-run it from the document's retry action, or its project's re-index; both
dispatch it again and count a new attempt.
