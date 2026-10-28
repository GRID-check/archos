# The agent: `packages/agent/src/agent`

The Python half of Piloti: LangGraph agents on the agent runtime (a third-party library), the
card surface, the post-answer stages, and the knowledge layer. Stateless per
turn. Conversation state lives in Postgres and reaches this process in headers
(ADR-0003, ADR-0013).

## The trap

`pytest` run directly tests this checkout's `packages/agent/src/`, because `pyproject.toml` puts
it first on the path. Before that setting, a bare `pytest` in a worktree without
its own venv validated whatever the venv installed, possibly the main checkout,
while everything passed. `PYTHONPATH=packages/agent/src` is still what `nat run` and ad-hoc
scripts need.

## Obligations

| When you | You must | What fails you |
|---|---|---|
| Add a tool or agent | `@register_function` with a `FunctionBaseConfig` subclass, then a `nat.plugins` entry point in the root `pyproject.toml` | The runtime never discovers it, and nothing reports that |
| Split a tool across optional deps | Give it its own entry point rather than importing from a neighbour's `register` | One missing extra (ifcopenshell, shapely) takes the whole plugin down. `bim_measure` is the worked example |
| Add a source kind | Add it to `SOURCE_KINDS` in `common/source_kinds.py` and run `uv run python scripts/generate_vocabularies.py`; then give it a tint (`KIND_TO_SIGNAL`) in `apps/workspace/bff/source-kinds.ts` | The `vocabularies` pre-commit hook and `tests/test_vocabularies_generated.py` for the tuple; `task workspace:types` for the missing tint |
| Emit a card | On chat, put it in the answer envelope's `cards` field (`cards/envelope.py`); Piloti no longer binds `emit_card`. Deep research still pushes through the `emit_card` tool, and a system card is pushed by the tool that did the work. Every path lands in the session `CardRegistry`; address a card from prose as `[[card:N]]` | The frontend resolves N positionally against the same ordered array. A card that bypasses the `CardRegistry` is unaddressable |
| Add per-turn state | A `ContextVar` registry created/reset per turn, the way `cards/registry.py` and `citations/session.py` do | Module-level state leaks across turns and across tenants. Process-lifetime state is allowed only when it holds no tenant or turn data: a bounded cache keyed by model id or content (the query-embedding LRU and its in-flight dedupe in `knowledge_layer/llamaindex/query_embeddings.py`, `common/llm_factory._REASONING_MANDATORY`), a build-time handle (`knowledge/factory._SEARCH_RETRIEVER`), or references that keep running work alive (`agents/piloti/register._WARMING`) |
| Add a line to the grounding block a tool returns | Put the field on `GroundingHit` and the line in `render_grounding_block` (`common/grounding_block.py`), then read it back in `_entry_from_hit` (`citations/extraction.py`). Both producers build records; neither writes grammar text (ADR-0061) | The byte-identity fixtures in `packages/agent/tests/common/test_grounding_block.py`, and then the contract test, where the two readers stop agreeing |
| Add a tool that answers in the grounding grammar (`render_grounding_block`) | Register its name with the text parser too: `register_source_parser(lambda name: "<tool>" in name, parse_knowledge_layer)` in `citations/text_parsers.py` | Nothing on a live turn, which reads the records. A REPLAYED turn reads the text, falls through to the URL extractor, and its citations vanish. `project_lookup` was written without it, and only a test that replays its result caught it |
| Build a prompt block from rows | Bound it, and say in the text the model reads that it is bounded | Cost grows with project size on every turn, and the agent answers "which files do I have" confidently and wrongly. See `render_inventory_block` |
| Change a card model (`cards/models.py`, the union, or a card's own module beside it, e.g. `cards/look_card.py`) | Re-run both generators: `uv run python scripts/generate_card_schema.py`, then `npm run generate:cards` in `apps/workspace` | The `card-schemas` pre-commit hook. Without it the frontend validates the old schema, and it type-checks |
| Change a builtin skill's `SKILL.md` | Re-run the generator: `node apps/workspace/scripts/sync-platform-skills.mjs` | `sync-platform-skills` pre-commit hook. A stale generated module type-checks perfectly, which is why it has broken the build from behind three times |
| Change a prompt or a model name | Remember `configs/*.yml` model names are the **boot fallback only**; the live default is admin-controlled | Editing YAML to move the fleet does nothing. See ADR-0014 |
| Call the BFF (`/api/internal/*`, `/api/mcp`) | Go through `common/bff_http.py`: `send`, `get_json`, `post_json` or `request_json`. It owns the base URL (`FRONTEND_INTERNAL_URL`, then `FRONTEND_URL`, then `http://frontend:3000`), the service token (no token, nothing is sent), the opener (no redirects, no proxies, HTTP only) and `BffError`; subclass that for your domain's error. Tests fake the transport at `bff_http._opener` and nowhere else | `packages/agent/tests/common/test_bff_http_ratchet.py`: a redirect guard, a `FRONTEND_INTERNAL_URL` read or the token header anywhere else fails it, and its allowlist of the httpx callers left to port may only shrink |
| Make a model call anywhere (a new route, an ingest step, a script) | Go through `common/openrouter.py`: `pin_chat_model`, `ResolvedCredential.request_body`, `PLATFORM_FIXED.apply`, `openai_client`, `pinned_http_client`, or `limited_async_http_client` for a body that already carries the policy. A model no organization chooses is always pinned; one it chooses follows `data_policy_for`. Name a platform-fixed model only if it has a zero-data-retention endpoint | `packages/agent/tests/common/test_openrouter_call_sites.py` and `test_provider_limiter_call_sites.py`. Zero data retention is on by default (ADR-0074), and a call that skips the seam sends a tenant's text to a provider that may keep it; a raw `httpx` client to OpenRouter also skips the provider limiter (ADR-0081) |

## Rules that need more than a row

**A measurement is not a source.** The four retrieved kinds (`building_law`,
`office`, `project`, `web`) are passages a citation resolves to and can be read
back. `measurement` is reproducible instead, carries GlobalIds and a tolerance, and
travels its own channel (`tools/bim/measurement_sources.py`). Putting one in
the `SourceRegistry` would let a basement measurement ground an uncited legal
verdict, the exact laundering path `piloti.grounding` exists to
close. The header of `common/source_kinds.py` is the full argument.

**`doc_class` is human-set and beats every filename guess.** The fine
`norm_registry` lanes are a sub-label within a coarse kind, never a kind of
their own.

**A model override arrives per agent group, through the context headers.**
Resolve it in `common/model_overrides.py`, which is the one place that knows the
group.

## Reference

- Adding a tool or a retrieval source:
  [`adding-a-tool.md`](../../../../docs/architecture/adding-a-tool.md).
- Editing a prompt template, and which model each agent role runs on:
  [`backend-deep-dive.md`](../../../../docs/architecture/backend-deep-dive.md#prompts-three-layers-and-where-each-is-authored)
  and [`llm-providers.md`](../../../../docs/architecture/llm-providers.md#which-model-each-role-uses).
- How the backend fits together:
  [`docs/architecture/backend-deep-dive.md`](../../../../docs/architecture/backend-deep-dive.md).
- `common/source_kinds.py`, `cards/registry.py` and `stages/runner.py` carry
  long "why" headers. They are the design docs that stayed next to the code, so
  read them before changing anything near them.
