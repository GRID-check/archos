# Module seams

Which module may import which is checked by a tool in each language, not by
review: dependency-cruiser for the UI (`task workspace:lint`), import-linter for the
Python packages (`task be:lint`). Each has a list of the violations that existed
when the check arrived. A new violation fails, and so does a listed one that is
gone, so the lists only shrink. That is the ratchet: fixing an edge removes its
line, and the line cannot come back.

## The UI: `apps/workspace`

The layers point one way: `app` → `features` → `components` → `lib`.

| Rule | What it forbids | Why |
|---|---|---|
| `lib-imports-ui` | `lib/` importing `features/` or `components/` | `lib/` is the headless core: the routes, the agent door and every feature share it. An upward import drags the UI into the server and the agent's operations |
| `lib-imports-app` | `lib/` importing `app/`, except `lib/agent-api/catalog/` | Each catalog operation loads the route it names, because the route stays the gate (ADR-0122). Nothing else in `lib/` has a reason to |
| `components-import-features` | `components/` importing `features/` | `components/` is the shared kit. A kit piece that knows a feature cannot be reused without it |
| `feature-deep-import` | `features/X` importing `features/Y/(components\|hooks\|stores\|lib)/…` | A feature's internals are its own. Reach another feature through its `index.ts` or a top-level module, or move the shared piece into `lib/` |
| `client-imports-server-only` | `features/`, `components/` or `hooks/` importing a module that starts with `import 'server-only'`, other than with `import type` | A value import puts the server module in the browser bundle. The list of server-only modules is read from the source on every run |
| `feature-cycle` | A feature-to-feature edge that closes a cycle | Two features that import each other are one feature with two names |

Test files, `test-utils/` and `mocks/` are not checked. A type-only import
counts like any other, except for `client-imports-server-only`.

The config is `apps/workspace/.dependency-cruiser.cjs`. `feature-cycle` is not a
dependency-cruiser rule: dependency-cruiser finds cycles between modules or
between leaf folders and keys each one by the path it walked, and those paths
move when an unrelated edge inside a feature does. The reporter
`scripts/module-seams-reporter.mjs` collapses the graph to one node per feature
and keys a cycle by its feature-to-feature edges instead.

### Working with it

- `bun run lint:seams` (inside `task workspace:lint`) passes the known violations and
  fails new ones, and fails a baseline entry whose violation is gone.
- Fixed one? `bun run lint:seams:baseline` removes the stale entries from both
  lists (`.dependency-cruiser-known-violations.json`,
  `.dependency-cruiser-known-feature-cycles.json`). It never adds one: the
  baseline runs in `shrink-only` mode.
- A new violation is fixed, not baselined. If one really must exist, change the
  rule in the config with the reason, in the same change.
- `node scripts/depcruise.mjs src --no-ignore-known` prints every violation,
  known ones included.

`scripts/depcruise.mjs` runs dependency-cruiser with its `typescript` pointed at
`typescript-api` (TypeScript 6). dependency-cruiser parses `.ts` through the
TypeScript compiler API and accepts `typescript` below 7, and TypeScript 7 ships
no compiler API (ADR-0103). Without the wrapper it skips every `.ts` file and
reports a clean graph. Delete the hook when TypeScript 7.1's API lands and
dependency-cruiser accepts it.

A run takes about thirty seconds, most of it parsing 2,900 modules.

## Python: `agent`, `backend`, `knowledge_layer`

The contracts are `[tool.importlinter]` in the root `pyproject.toml`. import-linter
builds the graph with grimp, which sees imports inside functions too.

| Contract | What it forbids | Allowed |
|---|---|---|
| `agent-api-seam` | `agent` importing `backend`, directly or through a chain. What the agent needs from a request is owned in `agent` and written by `backend` (`auth/request_identity.py`, `auth/errors.py`), or handed in by the API-tier caller (`oib_sync`'s `enqueue`) | nothing |
| `agent-knowledge-port` | `agent` importing `knowledge_layer` directly | `knowledge/factory.py`, the BaseRetriever/BaseIngestor port (ADR-0072); sixteen known bypasses, each listed |
| `qdrant-client-confined` | Any of the three packages importing `qdrant_client` directly | `knowledge_layer.qdrant` |

An `ignore_imports` entry whose import no longer exists fails the run
(import-linter's default), so a bypass routed through the port has to leave the
list in the same change. `lint-imports` runs in `task be:lint` and in the
`import-contracts` pre-commit hook, in about a second.

## Adding a seam

Add the rule where its language's rules are, run the check, and baseline what it
finds only if fixing it now is a change of its own. Say in the PR how many
entries the baseline starts with.
