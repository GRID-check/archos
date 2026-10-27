---
status: proposed
date: 2026-10-27
decision-makers: product owner (Matthias), Grid engineering
consulted: Grid engineering; six research reports of 2026-10-27 (internal audit, Deep Agents 0.7.32 source and changelog, industry survey of agent filesystems, a Deep Agents customisation prototype, the data mapping, extracted text)
informed: everyone working on Piloti's tools, the knowledge layer, ingestion, the wire and the Herleitung
---

# Piloti reads the office's documents through ls, glob, grep and read_file over its own backend, beside ranked search

## Context and Problem Statement

[ADR-0127](0127-search-finds-list-orients-read-reads.md) made the office's files
navigable beside RAG by growing three verbs Piloti already had: `list_files`,
`read_passage` and `knowledge_search(match="exact"|"regex")`. The capability is
there. The names are ours, and the model has to learn each of them from its
description: `list_files(view="tree")` for what every coding model calls `ls`,
`knowledge_search(match="exact")` for `grep`, `read_passage(pages=…)` for
`read_file`. Meanwhile `ls` and `read_file` already exist on the same turn and mean
the conversation's drafts (`src/aiq_agent/tools/documents/tools.py`, stock Deep
Agents tools over our `DraftBackend`), so the one pair of standard names Piloti
holds points at the one place that is never evidence.

Measured in the code on 2026-10-27 (`origin/develop` @ `ba4d5ba96`):

- **No full text is stored anywhere.** Every whole-document read rebuilds text from
  Qdrant chunks, three times over (`read_passage(pages=…)`,
  `knowledge/collection_pages.read_pages`, `browse._stored_chunks`). Section chunks
  overlap by 96 tokens across page breaks and start with a heading breadcrumb, so
  the page break inside a chunk is lost and an exact search counts a match in the
  overlap twice and matches breadcrumbs. The `pf-*` fixture seeds one chunk per page
  and cannot see either defect. [ADR-0134](0134-extracted-page-text-is-stored-per-version.md)
  decides where page text comes from.
- **The stock Deep Agents tools would lose what makes an answer citable.** Their
  `grep` returns `GrepMatch(path, line, text)` and sorts by path; their `read_file`
  returns the backend's text under an `@@ lines A-B @@` header. Neither renders a
  `GroundingHit` ([ADR-0061](0061-a-grounding-hit-is-a-record-and-the-text-is-its-rendering.md)),
  and without it citation verification, claim provenance
  ([ADR-0125](0125-every-sentence-shows-where-it-comes-from.md)) and the `high`
  confidence path have nothing to stand on.
- **The installed `deepagents` is 0.6.12.** The current release is 0.7.32
  (2026-10-23). 0.7.30 installs with no other bump; 0.7.32 needs `langchain>=1.4.7`,
  `langchain-core>=1.7.0` and `langsmith>=0.14.12` (PyPI `requires_dist`, read
  2026-10-27). 0.7.0 changed the backend protocol, the `read_file` format and made
  `write_file` overwrite.

The product owner decided on 2026-10-27 that Piloti's evidence over the office's
documents moves to the standard names, built on Deep Agents with our own backend
and our own rendering where the text matters: "customize as far as needed".

## Decision Drivers

* **Models are trained on `ls`, `glob`, `grep` and `read_file`.** Claude Code, Deep
  Agents, Cursor and the Claude Agent SDK all use these names and argument names
  (`path`, `pattern`, `output_mode`, `pages`). A name the model already knows costs
  no description tokens to teach and no round to misuse.
* **Hybrid beats either alone on documents like ours.** Cursor measured +12.5 %
  average QA accuracy for semantic search added to grep (2025-11-06). Microsoft's
  AgenticRAG reached 92.0 % on FinanceBench against 24.24 % for RAG and 32.71 % for a
  keyword-only shell agent, at 7.8× the tokens (arXiv 2605.05538, 2026-05-07).
  Anthropic calls the hybrid strategy "better suited for … legal or finance work"
  (context engineering, 2025-09-29).
* **The harness moves accuracy as much as the retriever.** PwC measured Opus at
  93.1 % in a custom harness and 76.7 % in Claude Code on the same retriever, and
  file-delivered results flipped 5 of 10 model and harness pairs (arXiv 2605.15184,
  2026-05-14). So we measure on our own suite, arm by arm, and do not import a
  number.
* **Citations, privacy and the Herleitung are not negotiable.** The citable unit is
  `<file>, p.N` (ADR-0061), a restricted document is never listed
  ([ADR-0088](0088-folder-access-is-read-write-per-role.md): listing is not use),
  and every call is one Herleitung row
  ([ADR-0132](0132-the-herleitung-shows-the-work-one-row-per-call.md)).
* **Buy, don't build.** Path validation, routing by prefix, pagination headers,
  truncation, eviction and the drafts store already exist in Deep Agents and we
  already depend on it twice (deep research, the draft verbs).
* **Our models run through OpenRouter.** Deep Agents' Anthropic prompt caching
  applies only to `ChatAnthropic` (`middleware/_utils.py`, 0.7.32), so it does
  nothing for us, and our own OpenRouter caching (`common/prompt_caching.py`) stays.

## Considered Options

* **Keep today's tools.** `list_files`, `read_passage` and
  `knowledge_search(match="exact"|"regex")`, as ADR-0127 grew them.
* **Stock Deep Agents filesystem tools as they are**, over a backend that projects
  the office's documents.
* **A shell over a virtual projection** (`just-bash`), the option ADR-0127 rejected.
* **Our backend behind the standard names**: Deep Agents' `FilesystemMiddleware`
  and `CompositeBackend`, our async read-only backend over our data, and our
  rendering wherever the result text matters.
* **One bash tool** in a sandbox over a copy of the files (Vercel's d0 shape).

## Decision Outcome

Chosen option: "Our backend behind the standard names", because it gives the model
the verbs it was trained on while every guarantee ADR-0127 kept (citable passages,
grep inside the index behind the scope filter, tenancy in Python inside the admitted
tool node) stays ours, and because the prototype showed each place where the stock
behaviour would have cost a citation, a privacy property or an eviction.

What it decides:

1. **Four tools with the standard names, over one namespace.** `ls`, `glob`, `grep`
   and `read_file` serve these mounts:

   | Mount | What | Writable |
   |---|---|---|
   | `/project/` | the turn's project | no |
   | `/office/` | the Büroablage | no |
   | `/chat/` | files dropped into this conversation | no |
   | `/law/oib/` | the platform's OIB corpus | no |
   | `/drafts/` | the conversation's drafts, today's `StoreBackend` | yes, through `write_file` and `edit_file` only |

   One namespace resolves the clash with the draft verbs: every stored draft call
   carries a `/drafts/` (or legacy `/entwuerfe/`) path, so the prefix tells old from
   new without guessing. Other projects stay behind `project_lookup`
   ([ADR-0094](0094-the-agent-searches-other-projects-as-the-conversations-audience.md)),
   because a cross-project read must not look like a local one. RIS and the web stay
   their own tools.
2. **Hybrid, always.** `grep` finds exact words, numbers and clause references. It is
   literal by default and takes `mode="regex"` to opt in. `knowledge_search` stays
   the ranked meaning search under its stored name and gains an optional `path=`.
   Both return the same citable page anchors. Meaning is never folded into `grep`:
   the stock formatter sorts by path, and a `grep` that ranks breaks the contract the
   model expects of the name.
3. **Scope by path is advised, never automatic.** A call without a path covers
   everything the person may see. The open folder or document is a hint in the turn
   context, never a filter. Only permissions are automatic.
4. **Deep Agents provides the shape; we provide the data and the result text.**
   Pinned to an exact version. The tools are built from a configured
   `FilesystemMiddleware` and bound into Piloti's tool node, the way the draft verbs
   are today (`tools/documents/tools.py`). Our `BackendProtocol` implementation is
   async and read-only, resolves tenant and scope from the run's context, and serves
   page text from ADR-0134's store. `read_file` and `grep(output_mode="content")`
   render grounding blocks. `ls`, `glob` and `grep` counts stay an index, never
   evidence. Stock code is reused where its output is not evidence: path validation,
   routing, `/drafts/`, pagination headers, truncation.
5. **A document's text is never served under a `.pdf` path.** The stock `read_file`
   decides by extension, and a `.pdf` path that returns text becomes a base64 file
   block (prototype p2). Extracted text is served as `<name>.pdf.md`, one entry per
   document, the stem being the immutable file name that is also the citation key's
   stem. `read_file` accepts the bare `<name>.pdf` and answers with the `.pdf.md`
   text. The [living design](../architecture/agent-filesystem.md) has the rule for
   every kind of document.
6. **Privacy: listing hides, reading admits.** A restricted document is absent from
   `ls` and `glob`. A guessed restricted path gets the same "no such file" as a real
   miss. A path the model got from a search hit reads, and the result is admitted or
   withheld at round end as today. The backend is the boundary: Deep Agents'
   `FilesystemPermission` filters only after the search has run, and the read-only
   SeaweedFS credential can read the whole bucket, so no object is ever resolved from
   a model-supplied path. A path resolves document → version → storage key through
   the turn's scoped lookup.
7. **Herleitung rows** (ADR-0132): `ls` and `glob` emit `list`, `grep` emits
   `search` (mode `exact` or `regex`), `read_file` emits `read`. Calls on `/drafts/`
   get no row and are never signed by the repeat-fetch guard, because a draft read
   after `edit_file` must not be withheld as a repeat. The `tool` step gains a typed
   `mount` field, because it stores only the tool name today and an estate
   `read_file` would be drawn as a draft.
8. **Citations ride on `ToolMessage.artifact`.** An outermost `awrap_tool_call`
   collects the `GroundingHit` records the backend appends to a per-call
   `ContextVar` and sets them on the result's `artifact`. Eviction keeps `artifact`,
   and parallel calls keep separate collectors (prototype p2, p3). The text parsers
   for the new names are registered too, because a replayed turn reads text, not
   records.
9. **What does not change with it.** Summarization stays off for chat: it moves the
   cached prefix, so it is measured before it is ever enabled. Deep research keeps its
   own runtime and is not mounted on the estate: its stock tools would read
   `/project/` around admission. It moves later, as an async subagent, in its own
   decision.

### Consequences

* Good, because the model gets four verbs it knows instead of three of ours, and the
  count still holds: `glob` and `grep` arrive, `list_files` and `read_passage` leave
  once the aliases go, and `ls` and `read_file` are already bound.
* Good, because one namespace ends the drafts name clash without renaming the draft
  verbs or invalidating a stored turn.
* Good, because `read_file` reads stored pages (ADR-0134), so a page-addressed read
  returns the page, a grep count counts the document and not its chunks, and an older
  Fassung's text exists even though its chunks were retired.
* Good, because `/law/oib/`, `/office/` and `/chat/` are served by the same four
  tools, so a question that spans the project and the law is one set of verbs.
* Bad, because Deep Agents churns. The 0.7 line shipped 32 patch releases in about 13
  weeks, and the `read_file` and `grep` output formats changed in 0.7.0 and 0.7.14.
  We pin an exact version and re-run the suite on every bump.
* Bad, because the cleanest extension point is private. Reusing the stock coroutine
  means overriding `_create_grep_tool` and `_create_read_file_tool`, which carry no
  stability promise. A pinned-version test has to fail loudly when they change.
* Bad, because the bump from 0.6.12 reaches the code that already uses Deep Agents:
  the draft verbs' `read_file` description promises a line-number gutter that 0.7
  no longer prints, `write_file` now overwrites, deep research's prompts name
  `write_todos` (no longer on by default) and `factory.py` passes the deprecated
  `_permissions=`.
* Bad, because two retrieval paths coexist while the aliases live: the old names stay
  registered for one release, since stored and replayed turns name them and NAT
  discovers tools by name. The suite's matcher maps old to new for that release.
* Bad, because a drawing's "text" is a vision model's reading of the sheet, not its
  printed text. `read_file` says so in the header, and a number quoted from it is
  still only `observed` when it comes from `look`.
* Bad, because a name promises a behaviour. A model trained on ripgrep expects regex
  and one trained on Deep Agents expects literal; a model trained on `read_file`
  expects line offsets, and a PDF has pages. The descriptions say which, and the eval
  has to show the model follows them.
* Neutral: OpenRouter is how we reach models, so Deep Agents' Anthropic caching and
  its harness profiles (keyed by `provider:model`) do not apply.

### Confirmation

Gates that will enforce it. None of them exists yet; each lands with the slice that
needs it, and until then review is the only gate.

* `task be:eval:answer-suite -- --set files` with three arms, grep only, semantic
  only and hybrid, before and after every slice.
* A test that a restricted document's path returns the same text as a path that
  does not exist, for `read_file`, `ls` of its folder and `glob`.
* A pinned-version test that builds the tools from `FilesystemMiddleware` and fails
  loudly when the stock builders' names, signatures or output headers change.
* A test that every chunk's body is a substring of its stored page (ADR-0134).
* A test that a draft read registers no source, and one that a path under
  `/drafts/` is never repeat-fetch-signed.
* A test that deep research binds no estate route.
* `tests/aiq_agent/common/test_backend_tools_schema.py` extended, so the door's
  operations carry `path` and an outside agent gets what Piloti gets.

## Pros and Cons of the Options

### Keep today's tools

* Good, because it is built, measured on the `pf-*` set and pinned by tests.
* Bad, because the names are ours, so every one costs description tokens and a
  learning round. Premise: models are trained on the standard names and not on ours,
  which holds as long as Claude Code, Deep Agents and Cursor keep those names.
* Bad, because `ls` and `read_file` stay bound to drafts on the same turn, so the
  standard names point at the one place that is never evidence.

### Stock Deep Agents tools as they are

* Good, because it is the least code: a backend and nothing else.
* Bad, because the stock `read_file` and `grep` attach no artifact and render no
  grounding block, so every read loses its citation. Premise: the stock tools set no
  `artifact` and their formatter reads only `path`, `line` and `text`
  (`utils.py:1142`, 0.7.32).
* Bad, because a `.pdf` path through the stock `read_file` becomes a base64 file
  block even when the backend returns text (prototype p2).
* Bad, because tool-level permissions post-filter: a deny on a path still let the
  backend search it, and the tool printed `No matches found` (prototype p4).
* Bad, because the stock `grep` is literal only and sorts by path. Premise: the
  0.7.32 grep description and `utils.py:1081`.

### A shell over a virtual projection (`just-bash`, ADR-0127)

* Good, because models know bash well, and Mintlify ran exactly this over Chroma:
  boot fell from about 46 s to about 100 ms, at 30,000+ conversations a day
  (2026-03-24).
* Bad, because `just-bash` is TypeScript beside a Python agent and provides no
  isolation, so every tenancy guarantee would be rebuilt there. Premise: a property
  of `just-bash`, not of a projection. ADR-0127's other two reasons (grep
  materialising every document, `cat` without chunk identity) were properties of
  that tool too, and neither holds for the chosen option, whose grep runs a Qdrant
  pre-filter and whose reads are grounding blocks.
* Bad, because Mintlify's corpus is Markdown, so rebuilding a page from chunks is
  lossless there and is not here (ADR-0134).

### Our backend behind the standard names (chosen)

* Good, because the prototype (Deep Agents 0.7.32, a scripted model, 2026-10-27)
  confirmed every seam it needs: a backend reads tenant and scope from
  `get_runtime().context` with one built graph across tenants; a `ContextVar`
  collector plus `awrap_tool_call` puts citations on `artifact`; eviction keeps
  `artifact`; a `/drafts/` `StoreBackend` route beside a read-only default works,
  with namespace isolation between organizations.
* Bad, because the prototype also found four traps, each now a rule above: a tool
  with a taken name silently replaces the stock one (the last bound wins, nothing
  warns); `CompositeBackend` always offers `delete`, so the tool allowlist must
  exclude it; with a read-only default, eviction fails silently and a 227,779-character
  result stayed in context, so `artifacts_root` is `/drafts/`; a subclass must keep
  the name `FilesystemMiddleware` or `create_deep_agent` appends it beside the stock
  one.
* Bad, because `CompositeBackend` fans a root search out route by route,
  sequentially, and an error from any route aborts the whole search, so our backend
  returns partial results with `truncated=True`, never an error.

### One bash tool (Vercel d0)

* Good, because Vercel cut 17 tools to one bash tool and went from 274.8 s to 77.4 s
  and from 4/5 to 5/5 correct (2025-12-22).
* Bad, because the sample is five queries, and the authors' own caveat is that "this
  only worked because our semantic layer was already good documentation". Premise: our
  corpus is PDFs, scans and drawings, not curated text.
* Bad, because a sandbox needs the bytes copied in, Unix permissions for tenancy and
  a text projection of every PDF anyway. Mintlify measured a 46 s p90 boot for that
  shape before leaving it.
* Bad, because the evidence that agentic search beats RAG comes from code, and the
  Claude Code team calls its own comparison "mostly vibes" (Latent Space, 2025-05-07).
  Anthropic's Agent SDK guidance (2025-09-29) is to start agentic and add semantic
  search "if you need faster results or more variations"; for an office's documents we
  already need both.

## More Information

**The slices**, each measured on `task be:eval:answer-suite -- --set files` before and
after:

| # | Slice | Reads off the suite |
|---|---|---|
| 0 | A realistic fixture: one `pf-*` document cut by the real section chunker (overlap, breadcrumbs), with count rows and a heading-word row | today's exact search fails the new count row, which proves the defect |
| 1 | Fix grep's double count in the overlap and breadcrumb matches, inside the existing `knowledge_search(match=…)` | the count rows pass, nothing else moves |
| 2 | `read_file` for the estate over stored pages (ADR-0134), chunk reconstruction as the fallback; `ToolStep.mount`; parser registration; `read_passage` aliased | read rows; citations kept (`citations_removed` = 0); quote-patch rate unchanged |
| 3 | `ls` and `glob`, folder cards as `README.md`, the mount digest in the prompt | orientation and locate rows; prompt tokens on chit-chat turns |
| 4 | `grep` under its own name, with the three arms | exact, regex and scoped rows; rounds per turn |
| 5 | `/law/oib/`, `/office/`, `/chat/` mounts; `knowledge_search(path=…)` | the mixed-law row and the OIB rows; `high` share unchanged |
| 6 | The prompt rewritten around the four verbs, then the aliases retired | navigate arm against hybrid |
| 7 | An audience-aware BFF tree route, for empty folders and folder descriptions | the orientation row with an empty folder |

**Revisit when:** the grep-only arm matches hybrid on the `pf-*` set (the round-0
prefetch may then become a listing); hybrid loses to semantic-only on any question
family (roll back that family's prompt rule); a Deep Agents bump breaks the
pinned-version test twice in a quarter (own the tool builders outright and keep only
the backend protocol); Qdrant's `MatchText` pre-filter is shown to drop matches the
stored text holds (move the pre-filter to an exact engine, ADR-0134 names one).

**Prompting advice.** The Anthropic posts cited here (2025-09) are older than the
three-month window that applies to prompt and tool-description changes
([working style](../contributing/working-style.md#prompting-advice-has-a-three-month-shelf-life)).
They are evidence for the architecture. The tool descriptions written in slices 2 to 6
take their advice from sources inside the window.

**The living design**, with paths, tool contracts, example outputs and the Deep Agents
recipe: [`agent-filesystem.md`](../architecture/agent-filesystem.md).

**What this amends.** ADR-0127's rejection of a shell over a projection rested on
`just-bash`-specific premises; it carries a dated note pointing here.
[ADR-0046](0046-agent-skills.md)'s rejection of `SkillsMiddleware` for chat rested on
premises that no longer hold either; it carries its own note, and moving chat skills is
decided separately.
