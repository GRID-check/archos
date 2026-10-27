# Audits, measurements and run logs

Two kinds of record live here, and neither is live:

- **Dated audits and measurements.** Each describes the code or a measurement as
  it stood in the month its file name carries. Read one as evidence of that
  date, and check the claim against the tree before acting on it. A register
  that is kept current as the code moves (the
  [hobble register](../architecture/hobble-register-2026-09.md)) stays under
  `architecture/` instead.
- **Frozen working files from agent loops that have finished.** They are kept
  for provenance: several accepted specs cite them as the evidence behind a
  decision, by item id. Do not append to these files, and do not treat an open
  item in one as work that is still queued.

The one live backlog is the
[continuous-improvement ledger](../roadmap/continuous-improvement-ledger.md).

## Dated audits and measurements

| File | What it examined |
|---|---|
| [`scaling-review-2026-07.md`](scaling-review-2026-07.md) | Caching, queueing, query and agent scaling |
| [`scaling-review-2026-07-phase2.md`](scaling-review-2026-07-phase2.md) | Agent state and persistence, phase 2 of the scaling review |
| [`citation-system-audit-2026-07.md`](citation-system-audit-2026-07.md) | The citation pipeline as built |
| [`memory-system-audit-2026-07.md`](memory-system-audit-2026-07.md) | The project memory system |
| [`quote-verification-calibration-2026-07.md`](quote-verification-calibration-2026-07.md) | Quote-verification thresholds, calibrated |
| [`authorization-audit-2026-08.md`](authorization-audit-2026-08.md) | Authorization and permissions, audit and remediation |
| [`rag-system-audit-2026-08.md`](rag-system-audit-2026-08.md) | Retrieval quality |
| [`latency-and-caching-audit-2026-09.md`](latency-and-caching-audit-2026-09.md) | Chat-turn latency and LLM caching |
| [`turn-latency-measured-2026-09.md`](turn-latency-measured-2026-09.md) | Where a chat turn's seconds go, measured |
| [`turns-per-answer-audit-2026-09.md`](turns-per-answer-audit-2026-09.md) | LLM calls per answer |
| [`repair-pass-alternatives-2026-09.md`](repair-pass-alternatives-2026-09.md) | Alternatives to the answer repair pass after ADR-0066 |
| [`prompt-audit-2026-09.md`](prompt-audit-2026-09.md) | Whether the answering prompt defines a good answer |
| [`prompt-value-audit-2026-10.md`](prompt-value-audit-2026-10.md) | Piloti's system prompt, line by line |
| [`qdrant-gates-2026-10.md`](qdrant-gates-2026-10.md) | The Qdrant migration gates, measured once before the flip |

## Frozen run logs

| File | What it recorded | Period |
|---|---|---|
| [`feedback-backlog.md`](feedback-backlog.md) | Colleague feedback triage, verified against the code (`FB-*` ids) | from 2026-07-14 |
| [`pilot-feedback-triage-2026-09.md`](pilot-feedback-triage-2026-09.md) | Pre-pilot stakeholder feedback, every item verified against the code before anything was changed | 2026-09-01 |
| [`upload-and-filing-triage-2026-10.md`](upload-and-filing-triage-2026-10.md) | The ten upload & filing tickets: three built (ADR-0086, ADR-0087), one out of scope, six triaged against the code | 2026-10-01 |
| [`upload-and-filing-retriage-2026-10-06.md`](upload-and-filing-retriage-2026-10-06.md) | The six unbuilt tickets (1, 2, 3, 7, 8, 10) triaged again against the code after develop gave the Archiv folders; product questions with defaults, slices, order | 2026-10-06 |
| [`upload-governance-traceability-2026-10-06.md`](upload-governance-traceability-2026-10-06.md) | Every sentence of the upload-governance request and every checkbox of tickets 4, 5, 6 traced to code and tests, the leak matrix, the gap list | 2026-10-06 |
| [`project-lifecycle-2026-10.md`](project-lifecycle-2026-10.md) | The project lifecycle and the experience of closing: thirteen findings, the state machine of ADR-0098, what was deferred | 2026-10-10 |
| [`blast-radius-2026-10.md`](blast-radius-2026-10.md) | What a one-file change costs CI: selection sizes, fan-in hubs, import and setup cost, CI wall time; the quick wins taken, the ratchets added, and the structural fixes ranked | 2026-10-27 |
| [`ux-system-audit.md`](ux-system-audit.md) | UX system audit, rounds 0–8 | from 2026-07-10 |
| [`overnight-run-log.md`](overnight-run-log.md) | Overnight run cycles, one entry per cycle | from 2026-07-05 |
| [`overnight-run-backlog.md`](overnight-run-backlog.md) | The overnight loop's tier queue (`T*`, `PF-*`, `DEL-*` ids), the repo root's `backlog.md` until 2026-10 | 2026-07-05 to 2026-10-08 |

Who cites these:

- [`../design/click-dummy-overhaul-spec.md`](../design/click-dummy-overhaul-spec.md)
  draws its scope from `feedback-backlog.md` (FB-2/4/6/8/9/10/11/12) and `ux-system-audit.md`.
- `../plans/2026-07-16-ris-catalog-index-design.md` (removed; in git history at `56ee3329`)
  cites `feedback-backlog.md:106`.
- [`rag-system-audit-2026-08.md`](rag-system-audit-2026-08.md)
  cites `feedback-backlog.md` and `overnight-run-log.md`.
