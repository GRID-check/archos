# Ingest memory — verifying the bounded raster decode in production

An ingest worker's memory used to grow with the document. The embedded-image pass
decoded **every** raster of a page at full resolution and held all of them until
that page's last JPEG was built, so a plan set — a sheet per drawing, several big
rasters on a sheet — cost hundreds of MiB before the first caption was asked for.
`ingest-worker` pods were OOM-killed (exit 137) in the visual-analysis phase.

The fix (`perf(ingest): cap rasters on their metadata and decode one at a time`,
#1087) reads every raster's size from metadata (`PdfImage.get_px_size()`, which
decodes nothing), applies the per-document cap there, and only then decodes the
rasters it will actually analyse — one at a time, each downscaled before it is
held. Peak memory is one raster, not the document.

This runbook answers two questions against production:

1. Is the fixed build running in the tier?
2. Is the decode bounded the way the local lab says it should be?

**Every command below is read-only.** Nothing here starts an ingestion, restarts
a pod, scales a tier or writes to a database. `kubectl get`, `kubectl logs`,
`kubectl top` and a single `SELECT` inside the Postgres pod are the whole of it
(§7).

The behaviour itself is pinned by
[`tests/knowledge_layer_tests/test_heavy_document_memory.py`](../../tests/knowledge_layer_tests/test_heavy_document_memory.py)
and by `test_image_extraction_memory.py`, which run against the real `pypdfium2`.
The generated plan set they use is in
[`pdf_fixtures.py`](../../packages/knowledge-layer/testing/knowledge_layer_testing/pdf_fixtures.py)
(`write_plan_set`, also runnable from a shell with `--plan-set`).

## 0. Setup

```bash
export KUBECONFIG=/path/to/read-only.kubeconfig   # PowerShell: $env:KUBECONFIG = "C:\path\to\read-only.kubeconfig"
```

Everything is in namespace `grid`. The tier's pods carry the label
`app.kubernetes.io/name=ingest-worker`; the Deployment's own labels differ, so
address the pods by label, not by `-l` against the Deployment's selector.

## 1. Is the fix deployed?

```bash
kubectl -n grid get deploy ingest-worker \
  -o custom-columns='NAME:.metadata.name,IMAGE:.spec.template.spec.containers[0].image'
```

The tag is `sha-<commit>`. Two ways to tell whether that commit carries the fix:

```bash
git log --oneline <commit> -- packages/knowledge-layer/src/llamaindex/adapter.py
git merge-base --is-ancestor <commit> origin/develop && echo "on develop"
```

The faster check needs no checkout. The fixed build emits `[ingest-mem]` lines
(§3); the pre-fix build never does. On a pod that has ingested something,

```bash
kubectl -n grid logs deploy/ingest-worker --since=24h | grep -c '\[ingest-mem\]'
```

is zero on the pre-fix build and non-zero on the fixed one. (At the time of
writing prod runs `sha-c37419ac`, a merge of #1078, which predates #1087 — so the
lines are absent and the "before" column of §5 is what the tier is doing now.)

## 2. The incident signature

```bash
kubectl -n grid get pods -l app.kubernetes.io/name=ingest-worker \
  -o custom-columns='POD:.metadata.name,RESTARTS:.status.containerStatuses[0].restartCount,LAST:.status.containerStatuses[0].lastState.terminated.reason,EXIT:.status.containerStatuses[0].lastState.terminated.exitCode'
```

`LAST=OOMKilled` with `EXIT=137` is the incident. Read what the killed instance
was doing:

```bash
kubectl -n grid logs pod/<pod> --previous --tail=40
```

The last lines before the kill name the phase — `Processing file N/M
(mode=multimodal)`, `Extracted text from …`, `Extracted N tables from …`. An OOM
there, before the first vision call has been made, is the visual-analysis phase.
The line numbers in old logs belong to the build that wrote them, not to your
checkout.

The container's memory against its request and limit, without shelling into it:

```bash
kubectl -n grid top pod -l app.kubernetes.io/name=ingest-worker
```

Prod requests 8Gi and limits 12Gi (§6.3b of [the Kubernetes doc](kubernetes.md));
a pod sitting at its request with no traffic is the allocator holding its
high-water mark.

## 3. The memory lines (fixed build only)

```bash
kubectl -n grid logs deploy/ingest-worker --since=24h | grep '\[ingest-mem\]'
```

One file on the fixed build produces four lines:

```
[ingest-mem] file:start <name> rss=…MiB
[ingest-mem] rasters:start kept=<n> over_cap=<m> rss=…MiB
[ingest-mem] rasters:done kept=<n> rss=…MiB
[ingest-mem] file:written <name> elapsed=…s rss=…MiB
```

What each tells you:

- `rasters:start … over_cap=m` — the document held more than
  `GRID_MAX_IMAGES_PER_DOCUMENT` (64) rasters and `m` were dropped **before** any
  decode. `over_cap=0` means the cap was not in play for this file.
- `rss` at `rasters:start` against `rss` at `rasters:done` — the decode of the
  kept rasters. Bounded, this is a flat step of about one raster (tens of MiB)
  however many rasters were kept. A step that scales with `kept` is the
  regression this runbook exists to catch.
- `file:written … rss=` — the whole file. It should land back near `file:start`
  rather than stay at a new high-water mark for the rest of the job.
- The lines come from `/proc/self/statm`, so they are emitted on Linux only; a
  run on Windows or macOS logs nothing here.

The cap warning is a normal log line, and it exists on both builds:

```bash
kubectl -n grid logs deploy/ingest-worker --since=24h | grep 'holds [0-9]* embedded images'
# …/tmp/tmpXXXX.pdf holds 212 embedded images; analysing the 64 largest, 148 not indexed
```

Before the fix this line reported a cap that was applied *after* everything had
been decoded, so it never bounded the work. After the fix it is the cap doing
its job, and it should be read together with the `rasters:start` line above.

### 3a. The text pass (2026-10-19)

The raster lines above never appeared before the 2026-10-19 kills, because
those died earlier: inside `_extract_text_from_pdf`, before even its
`Extracted text from N PDF pages` line. pdfplumber caches every parsed object on
its `Page` until the page is closed, and nothing closed them, so a file of CAD
sheets held every sheet's paths until the last page was read (about 77 MiB per
sheet of 20 000 paths). Two 26-29 MB plan collections crossed 12 GiB that way.

The fixed build adds three lines, so the window between `file:start` and
`rasters:start` is measured:

```
[ingest-mem] text:done pages=<n> without_layout=<m> rss=…MiB
[ingest-mem] tables:done tables=<n> rss=…MiB
[ingest-mem] file:released <name> rss=…MiB
```

- `text:done` should sit within a few hundred MiB of `file:start` whatever the
  page count. `without_layout=m` is the pages over `GRID_PDF_PAGE_MAX_OBJECTS`
  that were read by PDFium instead (their text only); the same count is on the
  file's job status as `pages_read_without_layout`.
- `file:released` comes after `gc.collect()` and `malloc_trim(0)`. It should
  land back near the idle figure. Before it, the next file started from the last
  one's high-water mark (7.2 GiB after a 726-page document).
- `[ingest-perf]` is written in the file's `finally`, so a killed process never
  writes it. Its absence says the process died, not where.

## 4. Queue depth and dead jobs

The scaler reads `ingest_job_queue`, so the same table is what to look at when
pods are restarting. It lives in the `jobs` database in the app Postgres,
which is the CloudNativePG cluster `grid-pg`:

```bash
PRIMARY=$(kubectl -n grid get cluster grid-pg -o jsonpath='{.status.currentPrimary}')
kubectl -n grid exec "$PRIMARY" -- psql -U postgres -d jobs -Atc \
  "SELECT status, count(*) FROM ingest_job_queue GROUP BY status ORDER BY status;"
```

`dead|N` is the number of jobs that exhausted their retries; an OOM kill
mid-claim is one way a job gets there. KEDA scales the tier on the rows that are
not `dead` (`ingest-worker` ScaledObject, min 1, max 3 —
[k8s §6.3d](kubernetes.md)). A growing `dead` count while pods restarted is the
sequence to look for; a `dead` count that is flat while the queue drains is
normal.

## 5. What the lab measures, before and after

These numbers come from the real generated plan set (16 rasters at 3000×2200 px,
about 20 MB of pixels each, about 95 MB on disk) extracted through the production
entry point with the real `pypdfium2`, on one machine:

| Measurement | Pre-fix | Fixed |
|---|---|---|
| `PdfImage.get_bitmap` calls, 72-raster document, cap 64 | 73 | 64 |
| Full-resolution rasters held at once, two rasters a sheet | 2 | 1 |
| Peak RSS delta, 16 rasters (8 sheets × 2), indicative | 220 MiB | 196 MiB |
| Peak RSS delta, 16 rasters (2 sheets × 8), indicative | 358 MiB | 196 MiB |

The first two rows are counted exactly and are what the tests assert. The RSS
rows are a high-water mark: the allocator does not hand all freed memory back to
the OS, so they understate the difference, and they move a little between runs.
They are here to show the direction, not to be a threshold.

To reproduce the counted rows:

```bash
.venv/bin/python -m pytest tests/knowledge_layer_tests/test_heavy_document_memory.py -q
```

The two tests that discriminate are
`test_the_cap_and_the_icon_filter_bite_before_any_decode` (73 against 64 decodes)
and `test_a_full_resolution_raster_is_never_carried_past_its_decode` (39.6 MB of
full-resolution pixels against 19.8 MB). Both pass on `develop` and both fail
against the pre-fix `adapter.py`; the third test, that metadata agrees with the
decoded bitmap, passes on both, which is the property the metadata-first cap
rests on rather than a regression guard.

## 6. What this runbook cannot show

- **It cannot reconstruct a "before" for a document already ingested.** The
  lines are in pod logs and the logs rotate; the restart history (§2) is the only
  durable record of the OOMs.
- **It does not ingest anything.** An "after" needs the fixed build deployed and
  a heavy document uploaded through the product by an operator.
- **The RSS line is the process's resident set, not the container's.** It will
  not match `kubectl top` exactly: page cache, the allocator's arenas and the
  other worker threads all sit in the container figure and not in this one.
- **The lab fixture is a shape, not the production document.** It reproduces the
  profile on purpose — a sheet carrying several full-resolution embedded rasters
  — and a real plan set will differ in raster count, raster size and page count.

## 7. Nothing here writes

No `delete`, `scale`, `rollout`, `exec` other than the read-only `psql SELECT`,
no `POST /v1/ingest`, no `INSERT`, `UPDATE` or `DELETE`. If a step ever needs a
write, it belongs in the deployment doc, not here.
