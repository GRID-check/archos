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

The sweep re-ingests nothing: it reads each row's outcome back from what the backend
knows, so it is safe to repeat. The documents split in two by what the backend still holds.

- **Indexed** (chunks exist in the collection): the job finished and only the row is stale. The sweep
  reads the job's result, or failing that the collection listing, and the row becomes `completed`.
  The shelf listing reconciles one page of 100 rows, under the limit, which is why some rows
  of the same batches did settle: a listing read fixes only the rows on its page.
- **Not indexed** (no chunks): the job failed or died, and the backend keeps a finished job's status
  for only 24 hours (`FILE_TRACKING_RETENTION_SECONDS`), so the reason is gone. Nothing retains the
  category. A row older than 48 hours whose job the backend has forgotten, with no indexed
  file under its name, becomes `failed` with `interrupted: the ingestion job was lost before it
  finished; retry to index this file`, category `transient`, retryable. That is correct, not a
  regression: the document was never readable, and it now says so and offers a retry. To learn
  why a scan failed, read `ingest-worker` logs for the job id in the row's `metadata`; they
  are the only trace left.

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

`pending` should be gone. Expect the indexed share as `completed` and the rest as `failed`
(`ingest_failure_category = 'transient'`, `ingest_retryable = true`), about 304 and 224 for the two
batches of the 2026-10 incident.

## 4. Re-ingest the failed ones

The existing **Rescan failed ingestions** (Organization > Enterprise) sends every failed document of
one organization back through ingest under its own id. An organization admin
(`org:settings:manage`) starts it; it is `POST /api/organization/documents/reingest-failed`, answers
202 with a `bff-jobs` job, and a second press while one is open joins it. It pages the failed set with a
keyset and skips rows that are running, already finished or not eligible, so it is safe to repeat. It
is scoped to the organization, not to one batch: a failed document from another upload is retried too.
Run it once the sweep has finished, and `bff-jobs` must be up (it was down Oct 20 to 28).

A document that fails again keeps a real reason this time, from a job that is still young.

## 5. What can stay `pending`

A document younger than 48 hours whose job the backend has forgotten stays `pending` until it
is 48 hours old, then follows the rule above. A document whose collection the backend cannot list
is left alone for the round: outage is not evidence.
