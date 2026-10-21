---
status: accepted
date: 2026-10-21
decision-makers: Grid engineering
consulted: product owner
informed: everyone working in this repo
---

# Bulk work is owned by the server: a durable run on `bff_job_queue`, never a loop in the browser

## Context and Problem Statement

The root-sort feature („Alle Dateien in Ordner einsortieren…“) sorts up to 5000
loose files of a shelf into its folders. It shipped with the browser driving the
whole run: the page looped over chunks of documents through the filing judgement,
then over the moves, with a concurrency pool of requests. The product owner
rejected that shape. A run of a thousand files takes minutes, and a browser that
loops over it loses the run when the tab closes, the laptop sleeps, a deploy
rolls the pod, or the network drops once. The half that finished is moved and
the half that did not is silently left in the root; nobody else can see that the
run exists; and nothing of the server's retry, backoff or observability reaches
it.

The same defect is already present in other places. The multi-select move in the
file browser (`moveMany`, a 4-wide pool of `PATCH /api/documents/{id}/folder`)
and the re-read of a selected set of failed documents
(`use-bulk-reingest.ts`, a 4-wide pool of reingest requests) both loop over
server items in the browser.

## Decision Drivers

* A run over many items must finish when nobody is watching: a closed tab, a
  sleep, a deploy or a flaky network must not leave it half done.
* Anyone on the shelf must be able to see that the work is running, and where it
  got to.
* Retries, backoff and attempt limits already exist in the job queue
  (ADR-0079); a run must not reinvent them in a page.
* Tenancy, authorization and the database belong to the BFF (ADR-0003); the
  work must run where those rules are already enforced.
* A single request has a timeout at the edge and at the runner. A piece of work
  that outlives either must be cut into slices that each end well inside them.

## Considered Options

* **Browser-driven chunks** (what root-sort first shipped): the page loops, one
  request per chunk or move, with a concurrency pool.
* **One long request**: the BFF runs the whole sort inside one HTTP request.
* **A server run on `bff_job_queue`** (ADR-0079): a row the person can come back
  to, worked by a job in bounded slices, resumable from what the row saved.
* **A Python-side job**: the agent runs the sort as its own background job.

## Decision Outcome

Chosen option: "a server run on `bff_job_queue`", because it is the only option
where the work survives everything the browser does not, and where the retry,
backoff and attempt limits the queue already has apply to it unchanged.

The rule, for any work over many items or longer than one request (a sort, a bulk
move, an import, a reindex):

1. **The run is a row.** A row the person can come back to: its status, its
   progress, what it learned and what it did. The row is the state the run needs.
2. **The job works it in bounded slices.** A `bff_job_queue` job advances the
   row one slice at a time. Each slice ends well inside the runner's slice
   ceiling (`GRID_BFF_JOBS_SLICE_TIMEOUT_MS`, 300 s by default), and the job
   resumes from what the row saved, on any worker.
3. **The browser starts, reads and asks; it does not loop.** The browser may
   start a run, read it (by polling, or a live channel), and request its next
   step (apply, undo, cancel). It never loops over items, never keeps a
   concurrency pool of item requests, and never holds state the run needs.
4. **The run is its requester's.** Only the person who started it sees it and
   acts on it, and the job runs as them, with their rights read again at each
   slice.

Root-sort is the first run on this rule: table `root_sort_runs` (migration
0173), job kind `root_sort`, service `frontends/ui/src/lib/filing/root-sort-run.ts`.
Mail import (ADR-0085) is the existing example: a `mail_import` job files one
page of an archive per slice and moves a cursor on its row.

**Outside the rule.** Sending bytes the browser holds (a local file's upload, the
part upload of an archive, ADR-0085) is not a loop over server items; the server
cannot pull those bytes, and this decision does not judge how the browser sends
them. The rule covers a loop over items the server already holds.

**Debt, named.** Two browser loops over server items predate this decision and
are not yet runs:

* `frontends/ui/src/features/documents/hooks/use-document-moves.ts`, `moveMany`:
  the multi-select move, a 4-wide pool of `PATCH /api/documents/{id}/folder`. It
  is tolerated for a hand-picked selection, and it moves onto a server run.
* `frontends/ui/src/features/documents/hooks/use-bulk-reingest.ts`: the re-read of
  a selected set of failed documents, a 4-wide pool of reingest requests. The
  queue's `reingest_failed` already covers the whole organization, but not a
  selection, so this one moves onto a run as well.

The baseline `ci/browser_work_loops.json` lists these and the other browser pools
the ratchet finds, each with its reason.

### Consequences

* Good, because a closed tab, a sleep, a deploy or a retry loses no work: the
  next slice resumes from the row.
* Good, because the run is visible: the row says where it got to, to the person
  who started it, and the server's logs and Langfuse traces attach to a job rather
  than to a page.
* Good, because the queue's attempts, backoff (`GRID_BFF_JOBS_RETRY_BACKOFF_SECONDS`)
  and dead rows apply without a second implementation.
* Good, because the browser's code is smaller: a start, a read and a next-step
  request, and no state machine that can disagree with the server.
* Bad, because a run is slower to start than a loop: its first slice waits for a
  worker, and the dialog reads progress by polling (every two seconds while the
  run works).
* Bad, because the run is a second state machine that has to be kept right on
  the server, with a status check, a conditional update per slice, and a unique
  index that allows one run in work per shelf.
* Bad, because the debt above stays until it is paid. Until it is, a second person
  copying the pattern is the expected failure, and the ratchet is what catches it.

### Confirmation

`frontends/ui/src/browser-work-loops.spec.ts` is a per-file ratchet over the
browser code. It counts the three signatures of a loop the browser drives (a
`…CONCURRENCY` constant, a function named `pooled`, `workerPool`, `runPool` or
`withConcurrency`, and `Promise.all(Array.from({ length: … }, worker))`) against
`ci/browser_work_loops.json`. A file may not gain one, and a new file may not
appear with one. The spec's failure tells the author to make it a server run and
cites this ADR. The obligations row in `frontends/ui/AGENTS.md` names the rule for the author
before the test runs.

## Pros and Cons of the Options

### Browser-driven chunks

* Good, because it is what root-sort shipped first, and it needs no server state.
* Bad, because a run is lost with the tab, and nothing outside the page can see it.
* Bad, because the server's retries and observability do not reach it.

### One long request

* Good, because it is one call, with no state to keep.
* Bad, because it runs into the edge's and the runner's timeouts, and a request
  that dies half way has no record of which half.

### A Python-side job

* Good, because the agent already runs long work.
* Bad, because tenancy, authorization and the database are the BFF's
  (ADR-0003). The agent never decides tenancy and never writes Postgres; a Python
  job would need both, and would duplicate what the BFF already enforces.

## More Information

* ADR-0079: the `bff_job_queue`, its slices, attempts and backoff.
* ADR-0085: the mail import, the existing example of a slice that moves a cursor.
* ADR-0003: the BFF owns tenancy, authorization and the database.
* [`docs/architecture/proposed-changes.md`](../architecture/proposed-changes.md#sorting-the-root):
  the root-sort run as built.
* **Not enforced by the ratchet:** the signatures catch a pool, not a loop. A
  sequential `for … await fetch` in a browser file is not counted. Nothing
  enforces that case yet; review is the gate for it.
* **Open, not decided here:** whether a batch upload of many local files should
  be a server-held run. `upload-queue.ts` is baselined as local bytes, which is
  an accurate reason, not a decision that the design is right.
* **The trigger to revisit:** if a run's first slice waits long enough for a
  person to notice under normal load, the queue's priority or its worker pool is
  the thing to change, and this decision stands.
