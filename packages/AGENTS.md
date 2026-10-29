# Libraries: `packages/`

Two families live here: the standalone IFC packages, outside every workspace,
and the Python packages of the root uv workspace ([below](#the-python-packages-agent-knowledge-layer-ris-adapter-tavily-web-search)).
`brand/` is neither: the shared corporate design. `tokens.json` is the source;
`build-tokens.mjs` renders `dist/`, and `sync.mjs` writes committed copies into
`apps/website` and `apps/workspace`, each only its layer: a token with `"scope": "app"`
reaches the workspace only (`--check` fails on drift and on a file a copy should not hold).
The brand rules a machine can hold run in `scripts/check_brand_rules.mjs`. Brand strings live
in `identity.json` only, the React components in `react/`, AuthKit's stylesheet in
`authkit/authkit.css` (pasted into WorkOS branding per environment). `mark.svg` and
`build-brand-assets.mjs` render the icons into both apps, borrowing `apps/site`'s
sharp. Its README holds the design rules.

## The IFC packages

Two implementations of the same spatial surface over IFC: `ifc-spatial`
(TypeScript, MPL-2.0, also an MCP server) and `ifc-spatial-py` (a spike on
IfcOpenShell). The agent reaches them through
`agent/knowledge/ifc_spatial_client.py` (ADR-0045).

### The gate, and why it is not in `task verify`

Both suites run in CI, behind a `packages/ifc-spatial*/**` paths filter: the `packages` job
in [`ci.yml`](../.github/workflows/ci.yml), which `CI OK` requires. It is its
own job because both packages sit outside their neighbouring workspace —
`ifc-spatial` has its own `bun.lock` (not the UI's bun workspace),
`ifc-spatial-py` its own `uv.lock` (not the root uv workspace) — so neither
tier's install can run them.

```bash
task pkg:install    # both toolchains; `task setup` now does this too
task pkg:test       # both suites
task pkg:test:ts    # ifc-spatial: 194 tests + BOTH tsconfigs, ~10s
task pkg:test:py    # ifc-spatial-py: 636 tests, 1m40s on four workers, measured 2026-10-22
```

`task verify` does **not** run them, and the Python suite's four minutes is the
whole reason: it is a per-commit tax on a directory most changes never touch,
and CI already pays it on the commits that earn it. Run `task pkg:test`
yourself when you change `packages/` — the same discipline `task db:test:rls`
asks for at the tenant boundary. A change here is unverified until you have
pasted that output.

`--all-extras`, not `--extra dev`: `pytest` is the `dev` extra, and the suite
also collects `test_ids_export.py`, which needs `ifctester` from the `ids`
extra. Plain `uv run pytest` installs neither.

Adding another IFC-style package means adding it to `pkg:test` in `Taskfile.yml`
and its path to the `packages` filter in `.github/filters.yml`.

### Obligations

| When you | You must | What fails you |
|---|---|---|
| Change an operator | Keep the two implementations' answer contracts identical | The agent gets a different number depending on which engine answered, with nothing to detect it |
| Return a measurement | Carry the provenance: GlobalIds, the operator expression, an absolute tolerance | A measurement without provenance is a number the agent cannot defend, and it is not a citable source |
| Add a geometry dependency | Check the version floor comment in `ifc-spatial-py/pyproject.toml` first | The `shapely>=2.1` floor is there for the *test suite's* GEOS cross-checks, not for the operators. Leave it where it is |
| Edit `ifc-spatial` | Keep the MPL-2.0 headers and `NOTICE` intact | It is separately licensed from the rest of the repo |

### Reference

- ADR-0045, IFC models are a queryable building rather than another document.
- `ifc-spatial-py/COVERAGE.md` and `CORPUS.md` record what the spike actually
  covers, which is less than the operator list suggests.

## The Python packages: `agent`, `knowledge-layer`, `ris-adapter`, `tavily-web-search`

`agent` (the agent itself, `packages/agent/src/agent`, distribution `agent`) moved
here from `src/` in ADR-0145 row 8. Its suite is `packages/agent/tests`, and it runs in the
core suite (`be:test`, with the coverage gate) beside `tests/`, not in `be:test:sources`;
`tests/test_python_packages.py` knows that. Its own `AGENTS.md` is
[`agent/src/agent/AGENTS.md`](agent/src/agent/AGENTS.md).

`knowledge-layer` (ingestion and retrieval, the library the agent is built on),
`ris-adapter` (the RIS legal adapter) and `tavily-web-search` (web search), all
agent-runtime plugins. Each is its own uv workspace member with its own `pyproject.toml`
and tests, installed into the shared venv. They moved here from `sources/` in
ADR-0145 row 6.

### Running these tests

`task be:test:sources` runs them, and the backend CI job runs the same task.
Each package is named in three places, because `packages/` also holds the IFC
packages above, which no glob may catch: the root `pyproject.toml`'s
`[tool.uv.workspace]` members and pytest `testpaths`, and `PY_PACKAGES` in
`taskfiles/backend.yml`. `tests/test_python_packages.py` fails a package
listed in one and not the others.

```bash
task be:test:sources                          # what CI runs: every package, one run, xdist by file
.venv/bin/pytest packages/<package>/tests -q  # one package
```

No package here carries a `tests/__init__.py`. With one, pytest names its
conftest `tests.conftest`, the same name as the repo's own `tests/` suite, and a
run over both aborts with "Plugin already registered under a different name".
Keep it that way. A helper a test needs from another file lives in the
package's support package beside `tests/`, `<package>/testing/<package>_testing/`,
which pytest's `pythonpath` lists, and is imported by that name
(`from ris_adapter_testing.lookup import LookupHarness`), never by a dotted path
through a `tests` directory: `tests/test_test_imports.py` fails it, because a
hyphenated `packages/<distribution>/` has no dotted path to import by. A conftest only registers fixtures, imported from there.

The run is parallel (`-n logical --dist loadfile`), so a test may not write
into the repository or share any other state with a test in another file:
`test_qdrant_import_boundary.py` plants its offenders under `tmp_path` for that
reason. A collection costs 62 payload indexes to make (over four seconds), so
`qdrant_store` gives a test module one pair it shares, emptied after each test,
and drops it when a test changed more than its points; a test of how a
collection comes to be asks for `fresh_qdrant_store`. A test asserts what OUR
code sends and gets back, not what Qdrant does on its own: a check that only a
Qdrant upgrade could fail is not one of ours. A run without
`QDRANT_TEST_URL` skips them; `qdrant` (the release binary) on port 6333 is
enough to run them locally.

This suite went uncovered for a long time. CI now runs it in the Backend suites
job (`task be:test:sources`). A package once carried
three tests asserting a function signature the implementation had already
changed, and they stayed green through every gate because nothing ran them.

### Obligations

| When you | You must | What fails you |
|---|---|---|
| Add a Python package | Put it at `packages/<distribution>/`, list it in the three places above, then run `uv sync --group dev` | `tests/test_python_packages.py`; unlisted, it is a directory nothing installs or tests |
| Register a function | `@register_function` with a `FunctionBaseConfig` subclass, plus a `nat.plugins` entry point in the **package's own** `pyproject.toml` | The runtime never discovers it |
| Make it toggleable in the UI | Add it to the `data_sources` registry in `configs/config_oib_openrouter.yml` (the entry shape is `DataSourceEntry` in `agent/common/data_source_registry.py`) | The tool works and no user can turn it on |
| Add a third-party API | Read the key from config, never from a module-level `os.environ` at import | The plugin fails to import on a deployment that does not use it, taking unrelated tools with it |
| Return retrieved text | Return passages a citation can resolve to and be verified against | An unverifiable "source" launders an ungrounded claim. See `agent/common/source_kinds.py` |
| Return EVIDENCE the answer may cite | Build `GroundingHit` records and call `render_grounding_block` (`agent/common/grounding_block.py`, ADR-0061). Never write `Source:` / `Citation:` / `Relevance Score:` lines yourself | Nothing local, and the reader quietly loses the fields you meant to state. The renderer files the records under the bytes it returns, and `extract_sources_from_tool_result` reads them back; text it did not render falls to the regex parser, which recovers less than you stated |

### Reference

- `knowledge_search` has two answer shapes. A query that names a Richtlinie and
  nothing else returns the whole family: `norm_registry.family_query_number`
  detects it, `read_passage.family_overview` reads every member the corpus
  holds, and `ranked_search.RankedSearch` renders their scope passages ahead of the ranked
  hits with one `## Gliederung` per member as the block's trailer. It keeps at
  most four ranked hits beside the overview (`family_branch.FAMILY_RANKED_HITS`), and the
  requery judge does not run on a query whose overview was built
  (recorded as `search_input["requery_skipped"] = "family"`); a family the
  corpus lacks is judged as usual.
  Membership is derived from what is indexed, never listed.
- A ranked search the requery judge found insufficient is re-read by the `jev`
  decider after the requery round (`requery.judge_coverage`). A complete "no"
  adds a `Coverage: insufficient — …` line (`GroundingBlock.coverage_gap`)
  and keeps the pool whole (ADR-0064: a decision never withholds a passage);
  anything less claims nothing. Say
  "insufficient" through that field, never as text a producer writes itself:
  the line also says what it means (`COVERAGE_GAP_LABEL`, `COVERAGE_GAP_NOTE`),
  which the system prompt no longer does.
- The step-by-step for a new tool or data source, from package layout to
  binding it to an agent:
  [`adding-a-tool.md`](../docs/architecture/adding-a-tool.md).
- `uv run` here resolves an environment without the workspace packages. Use the
  venv that `uv sync --group dev` builds, which is what the Taskfile does.
