# The API plugin: `frontends/aiq_api`

The backend's FastAPI front end, loaded by NAT as a front-end plugin
(`_type: aiq_api`): REST routes, the async job API with SSE streaming, and
`/v1/ingest`. A uv workspace member, installed into the same venv as the agent.

## Obligations

| When you | You must | What fails you |
|---|---|---|
| Add a route | Put it in `src/aiq_api/routes/` and register it in exactly one role's list in `plugin.py`: `api_routers` / `API_APP_REGISTRARS` for `api`, `CHAT_ROUTERS` for `chat` (ADR-0082). Almost every route is `api`'s; `chat` serves the socket and what KEDA reads from it | `tests/test_roles.py`: a router under `routes/` that no role mounts, or both do, fails it. Without the list, the route exists and nothing serves it |
| Accept a request | Authenticate through `auth/middleware.py`; the validator is resolved from the `aiq_api.validators` entry point, not imported | The WorkOS validator is pluggable on purpose (ADR-0002). A direct import hard-wires identity into the API tier |
| Add a job phase | Emit it through `jobs/phase_events.py` so the SSE stream and the event store agree. A research job's own steps (claim, prepare, run, persist, finish) are functions in `jobs/agent_job.py`, `agent_job_setup.py` and `job_outcome.py`; a new step is a new function there, not a branch in `run_agent_job` | The UI's progress display and the stored history diverge, and only one of them is replayable |
| Store job payloads | Go through `jobs/payload_crypto.py` | Job payloads carry tenant content into a shared store |
| Remove or rename a `run_agent_job` parameter | Name the old key in `RETIRED_PAYLOAD_KEYS` (`jobs/worker.py`) in the same change, and change its field on `JobRequest` (`jobs/agent_job.py`) with it. Rows queued, and jobs running, at the upgrade replay the old payload | Every job in flight at the upgrade fails with a TypeError. `tests/test_retired_payload_keys.py` binds replays to the real signature, and `tests/test_agent_job_phases.py` fails a parameter `JobRequest` lacks |
| Change how a research job runs | Keep the one path: `jobs/submit.py` persists the job and its queue row, a `jobs/worker.py` replica claims and runs it, and the cancel route flips `job_info` to INTERRUPTED for the worker's `CancellationMonitor` to poll (ADR-0021). The `chat` role submits and the `api` role streams and cancels (ADR-0082), so the queue is the only place a job can live | A second execution path forks cancel, reclaim and the reaper, and only one of them gets tested |

## Rules that need more than a row

**This tier is stateless about identity and trusting about tenancy.** It
validates the JWT and reads the context headers; it does not look up who you
are. The BFF decided that (ADR-0003, ADR-0007). Anything that needs to *decide*
access belongs in the BFF, not here.

**Job workers are claimed in the database, not assigned.** Both queues are
tables on one claim, `aiq_agent.common.claim_queue` (ADR-0079): fewest running in
the lane (the organization) fleet-wide first, then the lane served longest ago,
then the lane with the oldest job, then the lane name; inside the lane
`interactive` before `bulk`, then oldest. Priority never picks the lane. It also
holds the heartbeat, the reclaim of stale claims, `release_claims` on a drain (no
attempt spent), and `dead` rows kept as a trace instead of a `DELETE`. A change to the order, the heartbeat or the dead
rows is made there, once. `jobs/queue.py` and `jobs/worker.py` are research's
table, encrypted payload and poison verdict on it; the reaper and the checkpoint
retention sweep assume it. Ingestion claims from its own table,
`aiq_agent.knowledge.ingest_queue`; `jobs/ingest_dispatch.py` puts jobs there and
`jobs/ingest_worker.py` is its dedicated tier, the only process that claims
(ADR-0076): the `chat` and `api` roles enqueue and never claim. New work of either kind
joins by claiming through its queue, never by an in-process pool alone.

**Research waits, it is not refused.** Capacity never makes `jobs/submit.py`
raise: `MAX_ACTIVE_JOBS_PER_ORG` is the claim's per-lane cap (read by the
worker), and the one 429 left is `MAX_QUEUED_JOBS_PER_ORG`, abuse protection on how
many jobs one organization may have waiting. A scheduled fire is `bulk`. Do not
turn a full cluster back into a refusal: a scheduled task that meets one is
skipped, not retried.

**A background run acts as its requester, by echo** (ADR-0108). The worker
injects the identity headers from the run's identity and, when the run carries
one, the requester's signed request-context envelope the BFF minted, so the
tools that act as a person behave as on a chat turn. The envelope is kept at
submit only when it verifies for the run's requester (`jobs/run_envelope.py`,
`capture_request_envelope`), travels in the encrypted payload, and is renewed
by the BFF at claim once it is an hour old. This tier verifies and forwards; it
never builds or signs one, and never logs one. Any refusal or failure means the
run acts as nobody and those tools refuse.

## Reference

- [`README.md`](README.md) here has the run commands and the layered
  architecture diagram.
- Endpoint contracts: [`docs/api/python-endpoints.md`](../../docs/api/python-endpoints.md).
- ADR-0021 (db-claimed workers), ADR-0018 (per-run state), ADR-0028 (conversation affinity).
