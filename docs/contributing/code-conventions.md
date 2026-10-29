# Code conventions

House rules that are not obvious from the code, each one written down because
somebody already paid for it. Language defaults and formatting live in the
tooling (`ruff`, `oxlint`, `tsconfig`), not here.

## Size limits

A source file (`.py`, `.ts`, `.tsx`, `.js`, `.jsx`, `.mjs`, `.cjs`) has at most
**600 lines**, and a Python
function at most **60**, from its `def` to its last line. Files reached three
to seven thousand lines and one function 962 one reasonable hunk at a time,
and review passed every hunk, so the limit is a check rather than a request:
`scripts/check_file_size.py`, the `file-size` hook in `task lint:repo`, which
CI's **Repo checks** job runs.

**Import statements are not counted**, nor the blank lines between two of
them: `import` and `from … import` in Python, `import … from` and
`export … from` in TypeScript and JavaScript, a multi-line one whole. An import
names a dependency; it is not logic anyone has to read through. While they
counted, the precise import cost lines: importing the one i18n namespace or the
one schema table a module uses, instead of a barrel that drags in every other,
grew a giant by a line per import and failed the check, so the ratchet
punished exactly the decoupling that keeps a change's test selection small
([`docs/audit/blast-radius-2026-10.md`](../audit/blast-radius-2026-10.md)).
A dynamic `import()` is an expression and counts.

It is a ratchet. `ci/size_baseline.json` records every file and function that
was over when the check arrived, at its size then:

- A file or function **not in the baseline** may not pass the limit. Split it.
- One **in the baseline** may not grow past its recorded count. Adding to a
  giant means taking the same lines out of it, or moving the part you touch
  into a module of its own first.
- When one **shrinks**, the check fails until the baseline follows: run
  `.venv/bin/python scripts/check_file_size.py --update`, which lowers and
  removes entries and never raises or adds one. A split stays split.
- A **move or rename** re-keys entries, so the baseline conflicts or reports
  the old path as gone and the new one as new. Regenerate it with
  `--rebaseline` and check its diff shows only the move.

Why these numbers: sixty lines is the function bar this file already sets
below. Six hundred lines is about ten such functions, a module a reader can
hold, and it puts the line where the tree already bends: 56 of the 977
components in `features/` and `components/` are over it, 27 of them over a
thousand, while the rest sit well under. TypeScript functions have no limit yet:
measuring them needs the TypeScript parser, which lives in the UI's
`node_modules` that the Repo checks job does not install.

Not checked, because their length follows their input rather than a design
choice: generated files (the card schemas' `src/shared/cards/generated.ts`,
`*.generated.*`, `*.d.ts`), tests,
specs, fixtures and test helpers, migrations, and copy (the i18n dictionaries,
the site's `src/data/` and `src/i18n/`). The list is `EXCLUDED` in the script.

## No brand names

No code or infrastructure name carries a brand, neither a retired one nor the
current one: no `aiq`, `grid`, `piloti` or `archos` in an identifier, file or <!-- brand-history -->
folder name, environment variable, route, header, table, metric, event,
resource, flag or tool name (ADR-0148). Name the thing for what it does: a
reply job, not `piloti_wakes`; `MAX_ACTIVE_JOBS_PER_ORG`, not a prefixed one. <!-- brand-history -->
The product has had four names, and every earlier rename was a code change
across thousands of lines.

**The name is copy, and it has one source: `packages/brand/identity.json`.**
Code reads `PRODUCT_NAME` (`apps/workspace/bff/brand.ts` in the UI and the BFF,
`agent.common.brand` in the agent); a dictionary string says `{productName}`
and a prompt says `{{ product_name }}`. Both constants read `identity.json`,
which `node packages/brand/sync.mjs` copies beside each reader (the two apps and
`packages/agent/src/agent/common/`). The same run writes the name into the few
files that must spell it as a literal because nothing can import there, the
service worker's fallback title and the icons' SVG `<title>`
(`packages/brand/name-copies.mjs`). So a rename is one edit to
`identity.json` and one sync. `tests/test_product_name_parity.py` holds every
copy to the source and runs the rename drill: it changes the name in a scratch
copy, syncs once, and checks every surface follows.

Comments and engineering docs use the role noun: the agent, the workspace, the
app. The name is written out only in `identity.json` and the brand package, the
first-impression documents (`VISION.md`, `README.md`, the user guides, the
glossary), blog prose, release notes and ADRs.

Two ratchets hold this, both in `task lint:repo` and CI's **Repo checks** job.
Each records the hits every file had when it arrived, a file may not gain one,
and a cleanup makes the check fail until `--update` lowers the entry; a move
re-keys entries with `--rebaseline`, and its diff must show only the move (the
prose check refuses a rebaseline that raises its total).

- **Identifiers**: `scripts/check_brand_names.py`, the `brand-names` hook,
  against `ci/brand_names_baseline.json`. A directory is its own key (`dir/`),
  so a new file inside an old directory is fine and a new branded folder is
  not. Not a hit: a brand as a bare word in prose, `grid` the English word (CSS
  and Tailwind, `grid` as a layout noun at the end of a name, `FileGrid`), URLs,
  host names and the repository's own name, and the Python package names
  `agent` and `agent_host` until their scripted rename (ADR-0145 row 10a). Not
  checked: ADRs, audits, release notes, migrations, the i18n dictionaries and
  the site's content, published assets, lockfiles and Markdown (`EXCLUDED` in
  the script). `identity.json` and its copies are excluded: they are where the
  name is meant to live.
- **Prose**: `scripts/check_brand_prose.py`, the `brand-prose` hook, against
  `ci/brand_prose_baseline.json`, over every text file git tracks. It counts a
  retired name as a word, in any file a person or an agent reads (copy,
  prompts, docs, error text, MCP instructions), and the current name typed out
  anywhere outside the places listed above, where it should have been
  `{productName}` or `PRODUCT_NAME`. Bare `grid` never counts. History keeps
  the names it was written under and is not counted: ADRs up to 0147, audits,
  migrations, the release notes in `ci/brand_history_manifest.txt` with their
  translations and past weekly summaries, a `docs/` file whose first line is
  `<!-- history: YYYY-MM-DD -->` dated on or before the cutover, and a legacy
  module whose header says `drop after release N`. A later record may quote an
  old name in backticks on a line marked `<!-- brand-history -->`. The legal
  notices (the app's `bff/legal/content/` and the website's privacy page) may
  name the former name in one parenthesis, "(vormals …)" or "(formerly …)",
  so a person who signed up under it sees the notice covers them (ADR-0148).
  `--summary` prints the hits by directory. The target is an empty baseline.

**Rename when you touch it.** The identifiers and texts in the two baselines
are frozen, not swept (ADR-0148). A change that edits a file renames the
branded names in it that it can rename safely, using ADR-0148's neutral-name
map, and lowers the entries with `--update`. A name that is stored, or that an
outside client calls, is not renamed in passing: it needs the expand, switch
and contract steps below.

The end state of the identifier ratchet is a baseline holding only the
infra-pending names ADR-0148 lists (the old deploy tiers, the Pulumi names, the
old domain). A CI assertion for that is switched on once the baseline is down
to them; it would fail today.

An externally visible name (an MCP tool an outside agent calls, a public
route, an analytics event) is renamed with the old name kept as an alias for
one release, never as a hard break.

A name two deployed tiers exchange (the `x-grid-*` service headers between
the BFF and the backend) moves by expand, switch, contract, because the tiers
roll out side by side: first every receiver reads the new name beside the old
(`lib/http/legacy-header-names.ts`, `agent_host.legacy_headers`), the next
release the senders switch, the release after the old name goes.

## Python

Ruff, line length 120, Python 3.14. New tools use `@register_function` with a
`FunctionBaseConfig` subclass.

### Shape of a function

The agent tier grew to nineteen thousand lines with functions that ran two
hundred lines deep and four `if`s wide, and the cost was not aesthetic: a fix
in the middle of one of them could not be tested on its own, and a reader had
to hold the whole thing to know which branch they were in. These rules are the
floor for anything under `packages/agent/src/agent`, the Python packages under `packages/` and `apps/agent-host`,
new or touched:

- **Two levels of nesting inside a function, at most.** A third `if`/`for`/
  `try` inside a function body is a function waiting to be named. Ruff's
  `PLR1702` (`max-nested-blocks = 2`) is the check; it is turned on for the
  paths that already meet it and joins the rest as they are brought under.
- **Early exit, never an `else` ladder.** Guard clauses first, the happy path
  last and unindented. `if not x: return` beats wrapping the body in `if x:`.
- **Sixty lines is long.** Past that, the function is doing two things.
  Split at the point where you would write a comment saying what the next
  block does; the comment is the function's name. Over sixty fails
  [the size check](#size-limits).
- **Pure where it can be.** Take inputs, return outputs. A function that reads
  or writes module-level state cannot be tested without resetting the world,
  and cannot run twice in one process safely. Module-level mutable state is
  reserved for the registries the agent runtime populates at boot, and each one has a
  `reset_*` for tests.
- **Never swallow.** `except Exception: pass`, or a bare `except` that logs
  and continues, hides the fault the next reader needs. Catch the exception
  you can handle, and re-raise or return a typed failure for the rest.
- **Gather what is independent.** Two `await`s that do not depend on each
  other are one `asyncio.gather`. The staged pipelines already do this with a
  bounded `Semaphore`; a sequential loop of awaits is the smell.
- **Data in, data out.** Prefer a small frozen dataclass or Pydantic model over
  a dict with agreed keys, and over a class that carries state between
  methods. A method that only uses `self` to reach one field is a function.

None of this is a licence to rewrite a file you are passing through. Touch a
function, leave it meeting the bar; leave the neighbours alone unless the
change needs them.

## TypeScript

### `any` is not a type we accept, in production code or in tests

`no-explicit-any` (typescript-eslint's rule, run by oxlint as
`typescript/no-explicit-any`) is an **error** in `apps/workspace/.oxlintrc.json`,
and the suite is clean. Reach for the real
type, a `Partial<T>` or `Pick<T, …>` of it, `unknown`, or a deliberate
`as unknown as T` at a single documented boundary.

For spec fixtures use the shared helpers rather than casting:

- `@/test-utils/store-fixtures`: `DeepPartial<TState>` plus `asStoreState` for
  zustand selector mocks. The fixture stays partial and every field is still
  checked against the real store.
- `@/test-utils/db-fixtures`: `makeProject`, `makeDocument`, `makeMemoryItem`
  for whole repository rows, and `asDb` for the one drizzle query-builder-stub
  boundary.

`any` in a test double is how fixtures silently drift from the code they stand
in for.

`no-console` allows `warn`, `error` and `debug`. `console.debug` is the dev-only
diagnostic channel and its call sites are `NODE_ENV`-gated.

### Raw `sql<T>` results are not runtime-validated, so coerce at the repository boundary

Drizzle decodes column values only for direct column references. A raw
``sql<Date>`max(...)` `` or ``sql<number>`count(...)` `` fragment is a
compile-time assertion and nothing more, so `tsc` and the LSP see no error even
when the driver hands back a string.

Convert on the way out of the repository (`new Date(row.x)`, `Number(row.x)`)
and never trust the annotation downstream. A missing coercion here produced the
profiler's `toISOString is not a function` crash; that fix and its
`totalDurationMsRaw` sibling are the reference pattern.

### A general-purpose helper belongs in a shared module

Before writing a text transform, a formatter, a date or number helper, or any
other utility that is not *about* your feature's domain, search for an existing
one. If you write a new one, put it where the next caller will look:
`lib/text/`, `lib/utils/`, `lib/format.ts`. `features/<x>/lib/` is for logic
that really is domain logic.

A private copy inside a feature file is a fork. The copies drift, and the drift
is invisible because each one looks locally correct. German transliteration
(`ä`→`ae`, `ß`→`ss`) existed in `MarkdownRenderer.tsx` and in
`norm-entry-editor.tsx`, and a third was being written into `lib/bim/bcf.ts`,
where its absence had been shipping `Beispielstraße` as the filename
`Beispielstra-e`. All three now call `lib/text/latinize.ts`.

Sharing is not merging. Keep the pieces that genuinely differ separate and say
why: `latinize` splits into `transliterateGerman` and `foldDiacritics` precisely
because Markdown anchors must not gain diacritic folding, since their ids are
already published in links. `bucket.ts`, `MentionPicker` and `passage-highlight`
each document why they keep their own fold. **Document the non-adopters.** An
unexplained holdout reads as an oversight and gets "fixed" later.

## Capability doctrine

Four terms, kept distinct on purpose:

| Term | What it is |
|---|---|
| Feature flag | A product decision |
| Environment variable | A real infrastructure dependency |
| Capability | Derived from a dependency, never a second flag |
| Availability | Flag AND capability |

Image upload is the worked example: the `image-upload` flag AND `vlm_available`,
which is derived from the VLM key. Do not add a redundant environment opt-in for
something the dependency already implies.

**An office capability's on/off switch is a WorkOS flag in `feature-flags.ts`,
never an environment variable.** Environment variables are for operator tuning
(a budget, a delay, a page cap) and wiring (a URL, a token). A flag is decided
per organization, changed in the dashboard with no deploy, and reaches the
Python tier through the BFF (`GET /api/internal/stages`), which has no WorkOS
client of its own. `FOLDER_CARDS` and `OFFICE_CONVENTIONS` were built
as variables and replaced by the `folder-cards` and `office-conventions` flags;
their tuning (`FOLDER_CARDS_MONTHLY_TOKENS`) stayed. Registering a flag:
[`workos-provisioning.md`](../deployment/workos-provisioning.md).
