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
  `deploy/pulumi/src/app/geometry.ts`), one typed route `POST /v1/internal/bim/geometry` plus
  `/healthz` and `/readyz`. It reuses the agent package's substrate rather than copying it: the
  shared cache, the BFF client, the model download with its memory admission
  (`ifc_spatial_client`), and the inbound checks, lifted into `agent.common.envelope_auth` and
  shared with `agent_host`. Every call into the engine goes through one adapter
  (`geometry_service/engine.py`).
* **The cache.** Tier A is the resident parse (two models a pod). Tier B is the model's element index
  in Dragonfly, `ifc:index:v1:{model}:{sha256(source identity)}`, 30 days, built single-flight
  under a 120 s `SET NX` lock. The broad-phase operations answer from Tier B alone, so a warmed model
  is answered by any replica without opening the IFC. A request waits 20 s for a cold build and is
  then answered `409 geometry_warming` with `retryAfter` while the build carries on.
* **The BFF routes are the only caller.** `POST /api/bim/models/{id}/geometry` passes the model's
  document read gate (`getAccessibleModel`, and again for a diff's base model), then calls the
  service with the internal token and a signed request-context envelope naming the person and the
  model's project. The service has **no access control of its own beyond that envelope**: it
  resolves the model through the BFF's `/api/internal/bim/source` with exactly the envelope's
  scope, so it can reach no model the BFF route did not already authorize.
* **One agent door, no native tools at the end.** The capability is the catalog operation
  `bim-model-geometry`, offered to outside agents and to Piloti alike. An agent searches around an
  element (`aroundGlobalId`, `globalId`); a raw box or point is accepted only from the person's
  viewer, enforced in `bff/bim/geometry-service.ts`. Piloti gets no new native tool.
* **The native IFC tools migrate to the door.** `ifc_query` and `ifc_measure` move behind door
  operations once the geometry service runs where their memory belongs; `ifc-query` is already
  withheld from outside agents as a duplicate of `bim-model-query`.

### Consequences

* Good: one access decision (the BFF's), one agent integration, one engine adapter; the
  geometry memory is sized and scaled on its own pods, and a warmed model costs a cache read.
* Good: Langfuse sees every call as a `bim-geometry` trace with the cache tier, and a cold one
  as `geometry-cold-ms`, the number the pods' sizing answers to.
* Bad: the service image carries the agent package's dependency closure for the few modules it
  imports (measured: 84 MB resident after import). Lifting the cache, the BFF client and the model
  download into a small shared package would drop it; that is the follow-up, not a blocker.
* Bad: a model resolved by id is found within the model's project and the office shelf; a model
  attached to a private chat (`scope = 'session'`) is not found by the service yet.
* Neutral: off by default (`geometryEnabled`); off, the route answers 503 and nothing else changes.

### Confirmation

* `apps/geometry/tests/test_geometry_service.py`: no envelope, no token or no user is a 403 and
  nothing is resolved; a Tier B hit downloads nothing; concurrent callers share one build; a lock
  held elsewhere waits; past the wait the answer is 409 `geometry_warming`.
* `bff/bim/geometry-service.spec.ts`: the read gate runs before the service is called, for a
  diff's base model too, and an agent's raw coordinate is refused.
* `exposure.config.spec.ts` and `tests/fixtures/exposure.json`: `bim-model-geometry` is offered to
  both audiences, `ifc-query` is withheld. Nothing yet fails a new native geometry tool.

## Open preconditions

* **The geometry worker's sizing.** Until the `geometry` Deployment runs with memory sized for real
  models (the defaults are 3 GiB requested, 6 GiB limit, two resident models), the native tools keep
  parsing on the `chat` and `api` pods, and their RSS stays the open risk ADR-0045 named. Moving
  `ifc_measure` and `ifc_query` to the door waits on this.
* **A pre-warm after extraction** (the `warm` operation exists) so the first question about a new
  revision does not pay the cold build.
