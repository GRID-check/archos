---
status: accepted
---

# ADR-0003: Next.js BFF + stateless Python agent

- **Date:** 2026-06-30
- **Deciders:** Grid Agent team
- **Related:** [ADR-0002](0002-outsource-identity-to-workos.md), [ADR-0004](0004-tenancy-ownership-and-access-model.md), [ADR-0005](0005-object-storage-for-documents-minio.md), [ADR-0006](0006-knowledge-collection-scoping.md), [`../architecture/multitenancy-and-auth-spec.md`](../architecture/multitenancy-and-auth-spec.md)

## Context

The existing Python AI-Q server has been accreting application and identity logic on
top of its core job. That conflates concerns: the Python service should only serve
the LLM/agent pipeline (inference and embedding), while the system of record for
users, organizations, projects, documents, and conversations belongs elsewhere.

We need a clear boundary so that tenancy, sessions, and persistence are owned by one
tier and the agent stays a focused, stateless compute service.

```mermaid
flowchart LR
  Browser[Browser UI] -->|session cookie| BFF[Next.js BFF\nApplication tier]
  BFF -->|SQL| PG[(Postgres)]
  BFF -->|S3 API| SeaweedFS[(SeaweedFS)]
  BFF -->|HTTP/WS + Bearer JWT + context| PY[Python AI-Q\nstateless inference + embedding]
  PY -->|vectors| Chroma[(ChromaDB)]
```

## Decision

We will split responsibilities into two tiers with a thin, explicit boundary.

**Next.js = Application / BFF tier.** It owns:

- The WorkOS session (see [ADR-0002](0002-outsource-identity-to-workos.md)).
- Organizations/projects CRUD, document upload, conversation persistence.
- Collection-naming/scoping policy (see [ADR-0006](0006-knowledge-collection-scoping.md)).
- Direct calls to **Postgres** and **SeaweedFS**.
- Calls to Python over **HTTP/WS** with a **Bearer JWT + explicit context**.

**Python AI-Q = stateless inference + embedding microservice.** Its contract:

- `infer(query, context) -> stream tokens + cards`, where
  `context = { org_id, project_id, user_id, role, collection_scope[], history }`.
  It receives user context for **attribution/personalization** but is **not the
  system of record**.
- `ingest(file_ref, collection) -> embed into a named Chroma collection`, where
  `file_ref` is a **presigned SeaweedFS URL**. It writes vectors to **Chroma only**;
  it **never** writes Postgres/SeaweedFS and **never** decides tenancy.

We choose **Option A (application logic in Next.js)** over a separate dedicated app
server, keeping a thin explicit boundary so that extracting a dedicated server
(**Option B**) later is **non-breaking**.

**Option B triggers** (when to extract a dedicated app server later):

- Heavy background jobs / queues.
- A non-TypeScript team.
- Application logic outgrowing Next.js.

## Consequences

### Positive

- Fewer services for a small team to operate.
- End-to-end TypeScript in the application tier.
- A shared **card Zod schema** across UI and BFF.
- The Python agent becomes simple, stateless, and horizontally scalable.

### Negative

- Risk of Next.js doing too much.

### Risks

- **Next.js overload** — mitigated by the explicit boundary and documented Option B
  triggers, keeping a later extraction non-breaking.

## Alternatives Considered

- **Dedicated Python/Go app server now (Option B)** — rejected as premature for the
  current team size and scope.
- **Keep application logic in the AI-Q server** — rejected; conflates inference with
  tenancy/persistence concerns.

## Open Questions / Follow-ups

- Define and version the shared card Zod schema.
- Confirm HTTP vs WS boundaries for streaming `infer`.

## Amendment 1 (2026-10-27): the Option B triggers fired, and Next.js stays the host

Two of the three Option B triggers have fired. Heavy background work exists:
the BFF job queue (ADR-0079) runs 19 job kinds (`BFF_JOB_KINDS` in
`frontends/ui/src/lib/jobs-queue/types.ts`) on its own `bff-jobs` pool, which
KEDA scales on queue depth. Application logic has grown well past page
rendering: `frontends/ui/src/app/api/internal/` holds 57 internal routes that
no browser calls. The third trigger has not fired: the team still writes
TypeScript.

**Decision: Next.js stays the only host of the BFF.** No dedicated app server
is extracted. What the triggers asked for is handled by two changes that keep
one codebase and one image:

- **The BFF code gets its own folder.** ADR-0145 row 9 moves
  `frontends/ui` to `apps/workspace` with `app/`, `ui/` and `bff/` inside.
  `bff/` is a file move of `src/lib/`, not a rewrite, so the boundary this
  record asked for becomes a directory a reader can see and a seam rule can
  check.
- **Job pods no longer boot the UI server.** With
  `GRID_BFF_JOBS_MODE=inprocess`, the `bff-jobs` supervisor runs each slice
  from a bundled entry built with the image, instead of starting `node
  server.js` to POST to `/api/internal/jobs/run` (PR #1259, ADR-0079
  amendment 1). The default stays `http` until each stack opts in.

**Option B is rejected again, on these premises:** the team writes TypeScript
and nobody proposes a second language for the application tier; the job slices
need the same services the routes call, and the bundled entry gives them those
without an HTTP hop; and the pain the triggers predicted (job pods paying for
a web server, application code hidden among UI code) is removed by the two
changes above. When any premise turns false (a non-TypeScript team, job
latency or memory that the bundled entry cannot meet, or a second client that
needs the BFF without Next.js), re-open the extraction, and supersede this
record and ADR-0145 together.

**Confirmation.** `bff-jobs.spec.ts` in `deploy/pulumi` asserts the job pool's
wiring, and the slice-bundle tests from PR #1259 build the bundle and run a
slice through it. The boundary inside the host is not enforced yet: after row
9, ADR-0145's two count ratchets on `apps/workspace/bff/` (client modules,
imports from `@/features`) only let it tighten.

## References

- [`../architecture/multitenancy-and-auth-spec.md`](../architecture/multitenancy-and-auth-spec.md)
