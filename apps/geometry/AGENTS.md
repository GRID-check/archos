# The geometry service: `apps/geometry`

Element boxes, boxes per group, what lies within a box or near an element, what is in a room,
what touches an element, clashes and box diffs over the office's IFC models (ADR-0149). One typed
route, `POST /v1/internal/bim/geometry`, whose only caller is the BFF's
`app/api/bim/models/[modelId]/geometry` route; every agent, Piloti included, reaches it through
the door's `bim-model-geometry` operation. Probes: `/healthz`, `/readyz`. Run it with
`python -m geometry_service`; its tests run in the api suite (`task be:test:api`).

## Obligations

| When you | You must | What fails you |
|---|---|---|
| Call the engine (`ifc_spatial`) | Go through `geometry_service/engine.py`, the one adapter | Review; a second call site is a second contract to wire at every engine change |
| Change the request body | Change `wire.py` and `apps/workspace/bff/bim/geometry-wire.ts` together, limits included | The BFF validates first; a limit only one side knows is a 422 nobody can explain |
| Decide who may read a model | Do not, here: the BFF decides all access (people, organization, project, folders, limits, the agent GlobalId rule) and hands over an already-authorized source. This service holds no project or folder logic; it checks the internal token, the envelope, and that a source is one the BFF handed over (`signed_sources.py`, input integrity), and never looks a model up | A second access decision downstream is weaker than the BFF's: the first version's re-resolution 404'd models in restricted folders the person was cleared for |
| Reach the cache or the model bytes | Reuse `agent.common.cache` and `agent.knowledge.ifc_spatial_client`; fetch bytes only through `fetch.py` (the object store's origin, no redirects, the signed ETag, bounded) | A copy of the download forks its memory admission and its guard; a looser fetch turns a signed URL into a way into the cluster |
