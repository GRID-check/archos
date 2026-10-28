# Patterns in use

Structural patterns this codebase actually applies, written down because they
were being learned by reading code. Each entry says where the pattern lives, why
it is there, and **whether anything enforces it**. An unenforced pattern is a
convention, and conventions decay.

A pattern that already has an ADR gets a pointer here, not a second explanation.

## Atomic design (frontend)

Atoms compose into molecules, molecules into organisms, organisms into a route.
An organism reaches for an atom, never for Tailwind; shape is a primitive and
the domain is an atom on top of it.

`features/bim/components/viewer/index.ts` is the clearest instance: a barrel
whose only job is enforcing the import direction, so a control needing a new
shape makes the kit grow rather than the organism.

Layers and rules:
[`../design/grid-design-language.md`](../design/grid-design-language.md#component-layers-atomic-design).
**Enforced by:** review only.

## Module seams

The UI's layers point one way, `app` → `features` → `components` → `lib`, and a
feature reaches another only through its index and never in a circle. In
Python, `agent` never imports `backend` (the API tier owns the request
identity's writes and hands its capabilities in) and reaches `knowledge_layer`
only through the port in `knowledge/factory.py` (ADR-0072).
The rules and the baselines that hold today's exceptions:
[`../contributing/module-seams.md`](../contributing/module-seams.md).
**Enforced by:** dependency-cruiser in `task workspace:lint`, import-linter in
`task be:lint`. Both baselines only shrink.

## Guard scripts

A bespoke check for a repo-specific failure that no off-the-shelf linter knows
about. Each one exists because the failure is invisible: the code reads
correctly and the wrong thing happens anyway.

| Script | Catches |
|---|---|
| `apps/workspace/scripts/check-static-utility-modifiers.mjs` | `bg-warning/15` against a static Tailwind v4 `@utility`, which matches no rule and is silently dropped. Reads the utility names out of `globals.css`, so it tracks the design system rather than a hardcoded list |
| `scripts/check_agent_docs.py` | An `AGENTS.md` no agent can reach, and a Markdown link to a file git does not track |
| `scripts/check_adrs.py` | The ADR index disagreeing with the directory |
| `scripts/validate_skills.py` | A malformed skill bundle |

The shape to copy: read the source of truth at check time instead of restating
it, so the guard cannot drift from what it guards.
**Enforced by:** `bun run lint` for the first, `task lint:repo` for the rest.

## Generated artifacts, guarded by `--check`

Several committed files are generated. The failure mode is always the same: a
stale generated module type-checks perfectly, so nothing local objects and only
CI knows. `platform-skills.ts` broke the build from behind three times before
its guard existed.

The guard is the generator itself in `--check` mode: run it, diff the output,
fail on a difference.

| Artifact | Generated from | Guarded |
|---|---|---|
| `apps/workspace/bff/skills/platform-skills.ts` | `packages/agent/src/agent/skills/builtin/*/SKILL.md` | yes, the `sync-platform-skills` pre-commit hook |
| `contracts/cards/schemas.json` | the card models (`packages/agent/src/agent/cards/models.py` and its card modules), via `scripts/generate_card_schema.py` | yes, the `card-schemas` pre-commit hook |
| `apps/workspace/shared/cards/generated.ts` | `contracts/cards/schemas.json`, via `apps/workspace/scripts/generate-card-schemas.mjs` | yes, the same hook |

The card schema is a two-stage pipeline from Pydantic models to Zod. Neither
generator has a `--check` flag, so the hook simply runs both: pre-commit fails
the commit when they modify anything, the same way `ruff format` does. That
works because neither stamps a timestamp, so a clean tree stays clean.

Until this hook existed, editing `cards/models.py` without re-running both
generators left the frontend validating the previous schema, and it
type-checked.

## Per-turn state in a `ContextVar`

The agent is stateless per turn but needs turn-scoped collectors: emitted
cards, resolved citations, cost, traces. Each is a registry created and reset per
turn behind a `ContextVar`, never module-level state, because the process serves
many tenants concurrently and module state leaks across both turns and tenants.

`cards/registry.py` and `citations/session.py` are the reference
pair; `common/cost_tracking.py`, `common/profiler.py` and
`tools/bim/measurement_sources.py` follow it. One narrower use of the same
shape: `turn/answer_stream.py` binds the turn's live prose (`_PROSE`, a
`LiveProse` holding the answer's id and whether prose already went out) with
`bound_live_prose` around the answering run in `conversation_register._answer`;
the graph's tasks copy it, and the token handler mutates the one object.
(Another, `turn_status.prefetch_scope`, marked the turn decision's prefetch
for a requery switch that was measured 3.4 s slower and removed with it:
[`docs/audit/turn-latency-measured-2026-09.md`](../audit/turn-latency-measured-2026-09.md) §3.5.)

A `ContextVar` set inside `asyncio.gather` (or any task) dies with that task,
because each task runs in a COPIED context: return the value instead. The entry
is under "A value a setup step sets in a `ContextVar` is empty when the turn
reads it" in [`../contributing/gotchas.md`](../contributing/gotchas.md#data-and-correctness).

**Module-level state that is allowed** is a bounded cache keyed by model id or by
content, whose value is the same whichever tenant or turn asks, or a
process-lifetime handle holding no tenant or turn data:

- the query-embedding LRU with its in-flight dedupe, keyed by (model, text), on
  the retriever in `packages/knowledge-layer/src/llamaindex/query_embeddings.py`;
- `knowledge/factory._SEARCH_RETRIEVER`, the retriever handle recorded when the
  knowledge tool is built;
- `agents/piloti/register._WARMING`, strong references to running warm-ups, so
  the loop does not drop a task it holds only weakly;
- the parsed-model cache in `apps/workspace/ui/features/diagrams/use-diagram-model.ts`,
  keyed by the mermaid source text and capped at 64.

Anything keyed by a tenant, a user, a conversation or a turn goes behind a
`ContextVar` or into the database.
**Enforced by:** review.

## Idempotent global registration

Registering a converter or an exporter with NAT is a process-global side effect,
and the modules that need it are imported from several entry points. The
convention is a module-level `ensure_registered()` that is safe to call twice,
called explicitly by each entry point rather than run at import time.

`observability/otlp_logging_method.py`,
`observability/otel_header_redaction_exporter.py`.
**Enforced by:** review.

## Plugin discovery by entry point

Agents, tools and data sources are found through `nat.plugins` entry points in
the root `pyproject.toml`, not by importing a registry module. This is what lets
a tool with heavy optional dependencies stay independently loadable:
`aiq_bim_measure` is a second entry point precisely so `ifc_query` keeps working
where ifcopenshell and shapely are not installed.

A function that is registered but has no entry point does not exist at runtime.
Telemetry `_type`s are the same: `otelcollector_logs` sat in the shipped YAML
with no entry point and CrashLoopBackOff'd the agent.
**Enforced by:** `test_nat_plugins_entry_points_name_the_telemetry_modules` for
those two; nothing else. It fails as absence, which is why it is worth knowing.

## Declare in code, reconcile against the vendor, gate on drift

The authorization catalog (`lib/authz/catalog.ts`) and the audit-log schemas are
declared in the repository and pushed to WorkOS by a provisioning script. The
script's **default mode is read-only check**; `--apply` is opt-in.

That makes the same script a drift detector, and the `WorkOS drift` workflow
runs it in check mode against staging on a schedule.
[`../deployment/workos-provisioning.md`](../deployment/workos-provisioning.md),
ADR-0038. **Enforced by:** the `workos-drift` workflow and `authz-coverage.spec.ts`.

The platform prompt follows the same shape without the drift gate.
`scripts/prompts_push.py` (`task prompts:push`) checks by default and publishes
the committed `piloti_static.md` under a Langfuse label only with `--apply`. It
never overwrites a Langfuse version that did not come from git. Provenance is
read off the version itself: what Langfuse serves must be byte-identical to a
committed text, either the file at the commit the version's message names or
the file at any commit in its history. Tags do not count, because Langfuse
keeps one tag list per prompt, not per version. Neither arm asks whether the
commit was reviewed, so text published from a branch that never merges stays
unreviewed; publish with `--apply` from `develop`. ADR-0060. **Enforced by:** `tests/test_prompts_push.py`; no drift
workflow runs it on a schedule.

## Headless first: one MCP surface

Every capability a person has is an operation in
`apps/workspace/bff/agent-api/catalog/`, naming the BFF route the UI calls. The
MCP server at `/api/mcp` runs that route's handler in-process as the person, so
authz, rate limit and body schema are the route's own. A route that is not a
person's act (transport, sign-in plumbing) is exempt with a reason. ADR-0122,
[`agent-surface.md`](agent-surface.md).
**Enforced by:** `apps/workspace/bff/agent-api/agent-reachability.spec.ts`; the
routes that predate it sit in a shrink-only baseline.

## Bulk work is a server run, never a browser loop

A move, a sort, an import or a reindex over many items, or longer than one
request, is a row the person comes back to, worked by a `bff_job_queue` job in
bounded slices (root sort is the first). The browser starts it, reads it and
asks for the next step; it never loops over items or keeps a pool of item
requests. The decision and its debt are ADR-0121.

`apps/workspace/tests/browser-work-loops.spec.ts` counts the pool signatures per
browser file against `ci/browser_work_loops.json`, where each count has its
reason. A count may not grow and a new file may not appear.
**Enforced by:** that ratchet, for pools only. A sequential browser loop is not
counted, so review is the gate for it.

## Already recorded elsewhere

| Pattern | Where |
|---|---|
| Route → service → repository layering | ADR-0017 |
| Row-level security as the tenancy backstop | ADR-0041, [`../database/row-level-security.md`](../database/row-level-security.md) |
| Layered admission control (edge rate limit, job and turn concurrency, euro budget) | ADR-0040, ADR-0015 |
| DB-claimed workers instead of an assigning scheduler | ADR-0021 |
| Materialised path for folders | ADR-0049 |
| Write-through usage rollups | ADR-0019 |
| Cards as the rich-UI layer, decisions persisted on the message | ADR-0012, ADR-0030 |

## Adding to this page

A pattern belongs here when it appears in more than one place, a newcomer would
otherwise infer it by reading code, and it is not already an ADR. Say what
enforces it. If the honest answer is "nothing", write that. Those are the gaps
worth closing next.
