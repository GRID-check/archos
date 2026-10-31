---
status: proposed
date: 2026-10-31
decision-makers: Grid engineering; the product owner set the direction on 2026-10-31
consulted: product owner
informed: everyone working in this repo
---

# Geometry runs as its own service behind the one agent door

Builds on [ADR-0045](0045-ifc-models-as-a-queryable-building-not-a-document.md) (one IFC parser, one
interpretation), [ADR-0122](0122-everything-a-person-can-do-an-agent-can-do.md) (the agent door) and
[ADR-0145](0145-the-repository-is-laid-out-by-job.md) (an app is an image). The slices it serves:
[`docs/roadmap/model-collaboration.md`](../roadmap/model-collaboration.md), F4 and F6.

## Context and Problem Statement

Model collaboration needs geometry the extracted index does not hold: where an element is (its
box), what lies near it, what is in a room, what clashes, what moved between two revisions. A
proposed model Anmerkung is framed from element boxes, never from coordinates a model wrote. The
only engine that reads IFC geometry is the Python one (`packages/ifc-spatial-py`), and today it
runs inside the agent process, behind native tools (`ifc_measure`), on the `chat` and `api` pods.

A parsed model is resident memory of 20x to 140x its file size. Running the new operations on the
`api` role would put that memory on the pods that serve every other backend route, and running them
behind new native tools would give Piloti a second way to geometry beside the door every other
agent uses. Two questions: where the engine runs, and how agents reach it.

## Decision Drivers

* One integration for every agent: the MCP door at `/api/mcp` (ADR-0122), Piloti included.
* Access is decided once, by the BFF, on the model's document (ADR-0003, ADR-0045).
* A parsed model's memory must be sized on pods that do nothing else.
* One geometry implementation (the engine), no second stack, no extraction table.

## Considered Options

1. New native tools on the agent, the engine in the `api` role. Rejected on two premises: that
   Piloti and outside agents should reach a capability the same way (ADR-0122's door), and that a
   parsed model costs 20x to 140x its file in resident memory (measured for ADR-0045), which the
   `api` pods are not sized for. A cheaper engine footprint would reopen the second.
2. A typed route on the `api` role, called by the BFF; Piloti keeps native tools. Rejected on the
   same memory premise, and because two paths to one capability drift.
3. **A separate geometry service, called only by the BFF's route; every agent, Piloti included,
   reaches it through the door's operation.**

## Decision Outcome

Chosen option 3.

* **The service.** `apps/geometry` (image `geometry`, Deployment and ClusterIP Service `geometry`,
  `deploy/pulumi/src/app/geometry.ts`). It **speaks MCP itself**: an MCP server at `/mcp/`
  (streamable HTTP, stateless, JSON answers; the official `mcp` SDK's low-level `Server`), one tool
  per operation (`boxes`, `group-boxes`, `within`, `near`, `in-room`, `neighbours`, `clash`, `diff`,
  `warm`). Each tool's input schema is generated from the pydantic model the call is validated
  with, and its description is in English. Probes: `/healthz` and `/readyz`. The earlier typed
  JSON route is gone; nothing needed it once the BFF called the tools. The engine's own stdio MCP
  server (`ifc_spatial.mcp_server`) is not reused: it works on file paths and model handles and has
  no idea of a source handed over by whoever decided access. The service reuses the agent package's
  substrate rather than copying it: the shared cache, the model download with its memory admission
  (`ifc_spatial_client`), and the inbound checks, lifted into `agent.common.envelope_auth` and
  shared with `agent_host`. Every call into the engine goes through one adapter
  (`geometry_service/engine.py`).
* **The cache.** Tier A is the resident parse (two models a pod). Tier B is the model's element index
  in Dragonfly, `ifc:index:v1:{model}:{sha256(source identity)}`, 30 days, built single-flight
  under a 120 s `SET NX` lock. The broad-phase operations answer from Tier B alone, so a warmed model
  is answered by any replica without opening the IFC. A request waits 20 s for a cold build and is
  then answered `409 geometry_warming` with `retryAfter` while the build carries on.
* **The BFF decides all access; the service decides none.** `POST /api/bim/models/{id}/geometry`
  is the only caller. It decides everything about who may see what: the person and the
  organization, the ifc-models flag, the project, the document's shelf, folders including
  restricted ones, a diff's base model, the rate limit, and the agent rule (an agent names
  GlobalIds, never a coordinate). Then it hands the service an **already-authorized source** per
  model: the presigned internal URL, the version (ETag, `updatedAt`) and the model id.
  The geometry service knows nothing about people, projects or folders. It computes geometry from
  the bytes it was handed. The envelope tells it whom to attribute the work to (a trace, a log);
  it is not consulted for access.
* **The signature is input integrity, not a permission check.** The sources travel in
  `x-model-sources`, HMAC-signed with a key derived from the internal token
  (`HMAC(token, "geometry-sources/v1")`, kind `model-sources`, so it never verifies as a
  request-context envelope or the reverse). They are bound to this request's envelope, model and
  op, and expire after a minute. The service fetches only what the BFF handed over, and only from
  its configured object store (`SEAWEED_ENDPOINT`), with no redirects, within the size and time
  bounds and only when the ETag is the signed one. The cache key is the model id and the source
  identity.
* **The earlier design's mistake.** The first version had the service resolve the model again
  through the BFF's internal lookup, with the envelope's project. That lookup is narrower than the
  person's rights: it hides every restricted folder and knows only one project. A person cleared
  for a restricted folder, or diffing against a model in another project, passed the BFF's gate
  and then got a 404 from the service. A second, weaker access decision downstream of the real one
  was the defect; handing over the authorized source removed it.
* **The BFF is the gateway.** `POST /api/bim/models/{id}/geometry` authorizes the model or models,
  applies the agent rule, hands over the sources, and calls the service tool the operation names
  (`tools/call`; the internal token, the envelope and the sources travel as headers of that one
  HTTP request). A `tools/call` without a source handed over for this model and tool is an error
  result (`source_not_signed`), and nothing is fetched.
* **One agent door, one operation, no native tools at the end.** The capability is the catalog
  operation `bim-model-geometry`, offered to outside agents and to Piloti alike, with an `op` field
  selecting the service tool. The alternative was one catalog operation per service tool, generated
  from the service's tool list into a checked-in file with a drift test. One operation was chosen:
  - each door tool is an operation naming a route (ADR-0122), and there is one route, the gateway,
    so per-tool operations would be nine names for one route and one gate;
  - the door's tool list is paid for on every `tools/list`. The nine tools' descriptions and
    schemas cost more than one operation whose `op` union carries them once, and the average-size
    ratchet (`mcp-server.spec.ts`) has no room for eight more tools;
  - no generator, no second fixture, nothing to drift: the BFF's `geometry-wire.ts` and the
    service's `wire.py` already have to match and are reviewed together.
  An agent searches around an element (`aroundGlobalId`, `globalId`); a raw box or point is
  accepted only from the person's viewer, enforced at the gateway. Piloti gets no new native tool.
* **The native IFC tools migrate to the door.** `ifc_query` and `ifc_measure` move behind door
  operations once the geometry service runs where their memory belongs; `ifc-query` is already
  withheld on every door (`withheld: duplicate`) as a duplicate of `bim-model-query`, which outside
  agents use instead. Piloti is unaffected: it reads models with its native `ifc_query`, never
  through the door's `ifc-query`.

### Consequences

* Good: one access decision (the BFF's), one agent integration, one engine adapter; the
  geometry memory is sized and scaled on its own pods, and a warmed model costs a cache read.
* Good: Langfuse sees every call as a `bim-geometry` trace with the cache tier, and a cold one
  as `geometry-cold-ms` (written by the service when the build completes, 409 or not), the number
  the pods' sizing answers to.
* Bad: the service image carries the agent package's dependency closure for the few modules it
  imports (measured: 84 MB resident after import). Lifting the cache, the BFF client and the model
  download into a small shared package would drop it; that is the follow-up, not a blocker.
* Neutral: the BFF presigns a URL on every call, also when the index is already cached, and asks
  the store for the ETag at most once a minute per object (a bounded in-process memo). The
  alternative, letting the service look the model up itself, is the second access decision this
  record removes.
* Bad: a held upload's model (ADR-0086) gets no source: the byte path reads screened files only, so
  its uploader is answered 404 until screening passes.
* Neutral: off by default (`geometryEnabled`); off, the route answers 503 and nothing else changes.

### Confirmation

* `apps/geometry/tests/test_geometry_service.py`: no envelope, no token or no user is a 403 and
  nothing is resolved; a Tier B hit downloads nothing; concurrent callers share one build; a lock
  held elsewhere waits; past the wait the answer is 409 `geometry_warming`.
* `bff/bim/geometry-service.spec.ts` and `geometry-service.folder-access.spec.ts`: the BFF's gate
  runs before the service is called (for a diff's base model too); a person cleared for a
  restricted folder gets the model's geometry, one not cleared is refused by the BFF before any URL
  is presigned; an agent's raw coordinate is refused.
* `apps/geometry/tests/test_geometry_service.py` and `test_geometry_source_guards.py`: only a source
  handed over for this request, model and op, unexpired, is fetched, and only from the object store,
  without redirects and with the signed ETag. The service never looks a model up itself.
* `exposure.config.spec.ts` and `tests/fixtures/exposure.json`: `bim-model-geometry` is offered to
  both audiences, `ifc-query` is withheld. Nothing yet fails a new native geometry tool.

## Writes: the direction, not built

The service never writes to storage. When change operations come (move an element, set a property,
split a model), they return a modified IFC or a change set **as a proposal**. The BFF stores it as a
draft Fassung of the model with a diff (`diff` already exists), and a person accepts it or not.
Writes need the person's yes; Piloti and any other agent only propose (ADR-0122, ADR-0105). The
gateway stays the one caller, so the proposal arrives where the review flow already lives.

## Open preconditions

* **The geometry worker's sizing.** Until the `geometry` Deployment runs with memory sized for real
  models (the defaults are 3 GiB requested, 6 GiB limit, two resident models), the native tools keep
  parsing on the `chat` and `api` pods, and their RSS stays the open risk ADR-0045 named. Moving
  `ifc_measure` and `ifc_query` to the door waits on this.
* **A pre-warm after extraction** (the `warm` operation exists) so the first question about a new
  revision does not pay the cold build.
