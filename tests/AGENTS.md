# The backend suite: `tests/`

pytest over `src/aiq_agent`, mirroring its package layout. This is the suite
`task be:test` runs and the one carrying CI's 65% coverage gate.

## The trap

`pyproject.toml` puts this checkout's `src/` ahead of the venv's editable install,
so `pytest` tests the code in front of you, whatever the venv was built from. A
worktree without its own venv is the case this guards: before that setting, a
bare `pytest` there tested the main checkout while everything passed.
`knowledge_layer` (under `sources/`) is not covered; see
[`docs/contributing/gotchas.md`](../docs/contributing/gotchas.md).
`.venv/bin/pytest tests/aiq_agent/cards` for one area; `task be:test:ci` carries
CI's 65% coverage gate.

## Conventions

| Thing | How it works here |
|---|---|
| Async tests | `asyncio_mode = "auto"`. No `@pytest.mark.asyncio` needed; the loop is session-scoped |
| Imports | `--import-mode=importlib` with `.`, `src` and the test-support packages on pytest's `pythonpath`, so `from tests.provider_doubles import ...` resolves the same under `pytest`, `python -m pytest` and an IDE runner |
| Helpers another test file needs | In `agent_testing` (`tests/aiq_agent/testing/`), imported by that name; a conftest only registers its fixtures. Never a dotted path through a suite directory (`tests.aiq_agent.…`): a directory move breaks it (ADR-0145). A module at the top of `tests/` and `tests.fixtures` stay importable as they are |
| Shared doubles | `tests/provider_doubles.py` holds the provider-contract double and NAT's client shape. Extend it rather than re-mocking a provider per file |
| `tests/conftest.py` | Every test loads it, so it imports only what every test needs; a fixture imports a heavy package in its body. `tests/test_import_weight.py` fails a conftest that loads LangChain, NAT, Qdrant or a whole package again (docs/audit/blast-radius-2026-10.md) |
| Fixtures on disk | `tests/fixtures/<area>/`, real captured payloads rather than hand-written approximations |
| Coverage | 65% floor on `src/aiq_agent`. It is a floor, not a target; a new module arriving untested spends everyone else's headroom |

## Obligations

| When you | You must | What fails you |
|---|---|---|
| Fix a bug | Add the test that fails without your fix | Review. A fix with no test is a fix that comes back |
| Share a helper between test files | Put it in the suite's `<distribution>_testing` package (`agent_testing`, `knowledge_layer_testing`, `ris_adapter_testing`) and import it by that name | `tests/test_test_imports.py` |
| Assert on an LLM call | Assert the contract, never the prose: tools bound, prompt block present, bounds respected | The test passes until the model changes its wording, then fails for no reason |
| Test tenant behaviour | Remember this suite does not exercise row-level security; `task db:test:rls` does, and `task verify` does not run it | A tenancy bug that only RLS would catch |
| Add a suite under `sources/` | Nothing extra — `task be:test:sources` runs it, in `be:verify` and in CI. Do not add a `tests/__init__.py` to it: a package named `tests` collides with this suite's `tests.conftest` ([`sources/AGENTS.md`](../sources/AGENTS.md)) | The **Backend tests** CI job |

## Reference

- The whole gate, CI's sharding and the security stack:
  [`docs/contributing/testing-and-verification.md`](../docs/contributing/testing-and-verification.md).
- The bar for "done": [`definition-of-done.md`](../docs/contributing/definition-of-done.md).
