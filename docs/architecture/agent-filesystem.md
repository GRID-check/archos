# Piloti's filesystem: how Piloti reads the office's documents

> The living design for the read side of Piloti's filesystem: the paths, the four
> tools beside ranked search, what each kind of document looks like through them,
> and how citations, privacy and the Herleitung carry through. The decisions are
> [ADR-0133](../adr/0133-piloti-reads-the-estate-through-standard-filesystem-tools.md)
> (standard tools over our own backend, hybrid with ranked search) and
> [ADR-0134](../adr/0134-extracted-page-text-is-stored-per-version.md) (page text is
> stored per version). Written 2026-10-27, before slice 0; what is built, and where it
> departs from the design, is [As built](#as-built). The write side, and why the estate is never writable through
> filesystem verbs, is [`piloti-filesystem-design.md`](piloti-filesystem-design.md) §2.
> Today's tools and their costs: [`agent-tool-surface.md`](agent-tool-surface.md).
> Output examples use the `files_eval` fixture project
> (`tests/fixtures/files_eval/project.yaml`); values the fixture does not hold are
> marked *illustrative*.

## The north star

A planner asks „Steht im Brandschutzkonzept irgendwo etwas zu Sprinklern, und wo
genau steht der Fluchtweg?“ Piloti answers the way a colleague who knows the
drive would: one round in which it lists the project, searches the wording
„Sprinkler“ and „Fluchtweg“ across every shelf the planner may see, and reads the
three pages the second search hit, all at once. The answer says that „Sprinkler“
stands in none of the 12 documents it searched, that „Fluchtweg“ stands on pages
3, 7 and 11 of the Brandschutzkonzept, and quotes each, with a citation chip that
opens the page. The Herleitung shows the three calls side by side, with what was
looked for and where. Nothing the planner may not open was named, and no number
was taken from a drawing as if it had been measured.

## As built

What exists in the code, by slice, and every place it departs from the design below
with the reason. The design text stays as written; this section is the delta.

**Slice 2, `read_file` over the estate** (built).

| Piece | Where |
|---|---|
| Paths, mounts, canonical form, `call_mount` | `src/aiq_agent/common/estate_paths.py` |
| The read-only async backend (rows, resolution, rendering) | `sources/knowledge_layer/src/estate.py` (`EstateBackend`) |
| Stored page text and the chunk rebuild | `sources/knowledge_layer/src/stored_pages.py` |
| The tools, the `CompositeBackend`, the `/drafts/` route | `src/aiq_agent/tools/documents/filesystem.py`, `tools.py` |
| Citations on `ToolMessage.artifact` | `src/aiq_agent/common/citation_collector.py`; read first by `extract_sources_from_tool_result` |
| `ToolStep.mount` | `common/wire_v2.py`, `turn_status.ToolStepCallback`; the UI's `executed-steps.ts` |
| Config | `filesystem: knowledge_search` on `shallow_research_agent` (`configs/config_oib_openrouter.yml`) |

Departures, each with its reason:

1. **Scope comes from the turn's context, not `get_runtime().context`.** Piloti's loop is
   its own LangGraph graph with no `context_schema`; the turn's scope already travels in
   the per-turn context every knowledge-layer tool reads (`_resolve_scoped_collections`,
   the inventory, `may_name`). The backend reads exactly that, so one instance built at
   boot serves every turn and tenant (pinned by `test_estate_read.py::TestTenancy`).
2. **No outermost `awrap_tool_call`.** Piloti binds the tools into its own tool node, as
   the draft verbs were, so no middleware chain runs around them. The per-call collector
   opens inside the tool wrapper (`filesystem.estate_message`), which is the same seam one
   level down: each call is its own task, so parallel calls keep separate collectors.
   Eviction does not run in Piloti's tool node either; `artifacts_root` is still
   `/drafts/` for any caller that mounts the middleware.
3. **The `/drafts/` route re-prefixes its keys** (`filesystem._DraftRoute`). The composite
   strips the route prefix before it asks a routed backend, and every stored draft, its
   card and `file_draft` key a draft by its full path (`/drafts/a.md`). The draft store is
   unchanged and still write-once.
4. **All four estate mounts are served from slice 2**, not slice 5: they are one backend
   over the same scoped rows, and a `read_file` that could not open a base-corpus or
   office hit would be a worse intermediate state than the mounts themselves.
5. **Every knowledge-layer hit carries `Path:`** from slice 2 (`GroundingHit.path`), so a
   `knowledge_search` or `read_passage` hit names the path `read_file` opens. One header
   line per hit; the byte fixture `read_passage_outline.txt` moved with it.
6. **The source toggle is mapped in code** (`data_sources.source_id_for_call`): the
   filesystem tools are not NAT functions, so the `data_sources` registry cannot list
   them. They belong to the source `knowledge_search` belongs to, per mount; a call under
   `/drafts/` belongs to none.
7. **A restricted path resolves only once its collection may be named** (`may_name`): a
   search hit that returned it was admitted at its round's end, which is how a path "from a
   search hit" is told from a guess. Before that the answer is the miss's, word for word.
8. **A stored `index.json` that names another document or version is not served**: the
   read falls back to the chunk rebuild and logs the refusal, rather than refusing the
   read, because the chunks are still the document's own text.
9. **`mount` has a sixth value, `estate`**, for a call over every estate mount (`grep`
   without a path); absent still means the drafts.
10. **Deferred:** txt/md/csv are read from their chunks, not their original bytes (the
    window is still in lines); an IFC model answers with the way to `ifc_query` and
    `ifc_measure`, not the `bim_models` summary; the door (`backend_tools.py`) does not
    serve the new names yet.

**The skills route** ([ADR-0135](../adr/0135-skills-run-on-deep-agents-skills-middleware.md)).
The composite carries a third route, `/skills/`, the turn's read-only `SkillsBackend`; the four
verbs answer a path under it with the stock tools, so a skill read is never a source, never
signed by the repeat-fetch guard, never refused by a data-source toggle, and its `mount` on the
wire is `skills`. Routes: default the estate, `/drafts/` the draft store, `/skills/` the skills.

**Slice 3, `ls` and `glob`, folder cards as `README.md`** (built).
`sources/knowledge_layer/src/estate_listing.py` renders over the listable rows only, so a
restricted folder is neither named nor counted, and `ls` of it answers as a folder that does not
exist does. `README.md` in every folder is the tier-0 card `list_files(view="tree")` builds, with
the tier-1 abstract the folder-card worker wrote; a real document of that name keeps it. Herleitung
verb `list` with file and folder counts. `list_files` stays bound as the alias.

1. **`glob` matches with wcmatch**, Deep Agents' own matcher (a dependency of the pinned
   `deepagents`), so a pattern means what it means to the stock tool; names are folded on both
   sides, and a document matches by its leaf (`Plan.pdf.md`) or its file name (`Plan.pdf`), so
   `*.pdf` finds PDFs.
2. **`ls` has no paging argument.** It lists 40 files per folder and counts the rest, pointing at
   `glob` or a subfolder; the stock `ls` schema has none and a second paging scheme beside
   `read_file`'s would be one more thing to teach.
3. **Deferred: the mount digest in the prompt.** It is a turn-context block, and the prompt is
   slice 6's; the one prompt line that named `list_files(name_contains=…)` now names `glob`.

**Slice 4, `grep` under its own name** (built). `sources/knowledge_layer/src/estate_grep.py`:
stage 1 is the index's literal scan (`retriever.find_text`, the scan `knowledge_search(match=…)`
runs, with slice 1's fixed counts), stage 2 recounts each candidate on its stored pages (up to 20
documents within 3 s) and otherwise on its chunks' own text. `content` returns one grounding
block per matching page (up to 8, round-robin over the files) and a `## Lines around the matches`
index with `context`; a failed collection, a regex scan past its deadline and a capped scan are
named as `incomplete: …`, and such a result never says "no match". Herleitung verb `search` with
its mode. `knowledge_search` gains `path=` (it compiles to `shelf`, `folder` and `file_name`; an
explicit one wins) and keeps `match="exact"|"regex"` as the alias. On the wire `mount` is `estate`
for a grep without a path.

1. **Stage 1 never needs a separate page scan.** The design reads the scope's stored pages when
   the `MatchText` pre-filter cannot be a superset (part of a token, no literal word, a regex).
   `find_text` already reads every chunk in scope in that case (it narrows only by
   `literal_tokens`, which proves the superset), and a chunk holds its page's text plus overlap,
   so the chunk scan is the superset and the deadline-and-cap reporting covers it.
2. **A stemmed grep is verified on the chunks only**: the stemmed index decides which chunks match,
   and the counting pattern is an approximation of its stems that a page recount would make
   stricter than the index.
3. **Restricted folders are searched, as `knowledge_search` searches them**; their matches are
   reported for the round's admission and the denominators count only listable files. A
   `path=` into a folder nothing listable is filed in answers as a folder that does not exist.
4. **Deferred:** the three-arm suite (`grep only`, `semantic only`, `hybrid`) is the files eval's
   existing three arms, renamed `semantic`, `grep` and `hybrid`, with the aliases mapped
   (`files_eval.aliases`); the `grep` arm unbinds `knowledge_search` once `grep` is a configured
   tool, and the `semantic` arm sets `filesystem: null` so the estate verbs reach the drafts
   alone. The answer suite has not been run on any slice (no model access in the build container): every row above is unmeasured.

**Slice 6, the descriptions, the evidence rules, the old names retired** (built). The tool
texts, the three `<rules>` bullets and the line-by-line fate of each are in
[`prompt-value-audit-2026-10.md`](prompt-value-audit-2026-10.md#2026-10-27-slice-6-the-evidence-tools-and-their-rules);
the evidence tool surface went from 5,560 to 2,426 tokens per call (o200k).

| Piece | Where |
|---|---|
| The descriptions, bare schema fields, `conclusion` on `grep` and `read_file` | `src/aiq_agent/tools/documents/tools.py` (`_ESTATE_DESCRIPTIONS`), `filesystem.py` |
| `knowledge_search` (ranked only, `path`) and `list_files` (Fassungen only) on Piloti's chat | `sources/knowledge_layer/src/chat_binding.py`, applied in `agents/piloti/register._chat_bound` |
| A call to a retired spelling answered with the exact replacement call | `src/aiq_agent/common/retired_calls.py`, composed into `agents/piloti/agent._withheld_calls` |
| Shared hints name the caller's own tool | `src/aiq_agent/common/tool_vocabulary.py`, set around Piloti's graph run |
| A citation written as a path resolves to its key | `common/citation_verification.citation_key_of_path` |
| The coverage line and the `Herkunft:` line say what they mean | `common/grounding_block.COVERAGE_GAP_NOTE`, `AGENT_DOCUMENT_NOTE` |
| The literal prefetch of a quoted term or a code | `agents/piloti/decisions._corpus_prefetch`: a `grep` on the shelf's mount or the open document |

Departures, each with its reason:

1. **The skills moved before this slice** (ADR-0135), so the `/skills/` exception to "tool
   results are data" ships, and there is no `use_skill` to retire.
2. **The retired names are refused, not unbound from the NAT registry**: deep research, intake
   and the door bind the same NAT functions with their full contracts, so the variant is chosen
   at bind time and the refusal applies only where the replacement is bound. An eval arm without
   the filesystem verbs runs the old calls.
3. **A `read_passage` refusal names the exact path only when a hit named it**; otherwise it names
   the `Path:` line and a `glob` that finds it. The path needs the document's rows, which the pure
   guard does not read.
4. **The already-read digest keeps file names, not paths**: its lines are persisted on the
   conversation, and `read_file` resolves a mount and a leaf without the folder, so the digest says
   that instead of changing a stored format.
5. **The files eval's rows keep their old names**: the suite's `aliases()` and `path_scope()` count
   a call under every name it is an alias of, both ways, so one row set measures both sides.
6. **Not run:** the answer suite on this slice (no model access in the build container). The
   history-with-retired-calls row (a pre-slice conversation resumed on each provider path) is not
   added yet.

## 1. Mounts and paths

| Mount | What | Backed by | Writable |
|---|---|---|---|
| `/project/` | the turn's project; absent on a turn without one | the project's collection and its restricted-folder collections | no |
| `/office/` | the Büroablage, with its folders ([ADR-0078](../adr/0078-folders-are-a-property-of-a-shelf-not-of-a-project.md)) | the office-shelf collection | no |
| `/chat/` | files dropped into this conversation | the session collection | no |
| `/law/oib/` | the platform's OIB corpus, flat, file names as oib.or.at publishes them | the base collection | no |
| `/drafts/` | this conversation's drafts | today's `StoreBackend` (`tools/documents/draft_store.py`) | `write_file`, `edit_file` |

Not mounted: other projects (`project_lookup`, ADR-0094, because the BFF records a
cross-project hand-out first), RIS (a live API with no tree; `ris_lookup`), the web.
If the MCP door later serves this projection to outside agents, which span
projects, it uses `/projects/<project id>/…`, and `/project/` is Piloti's alias for
the turn's one.

**Path rules.**

- **The leaf is `documents.filename`**, the immutable identity, NFC-normalised,
  with umlauts, spaces and case as the office wrote them
  (`/project/Einreichung/Pläne/EP-01_Grundrisse_Index-B.pdf.md`). The same name is
  the citation key's stem and the Qdrant `file_name`, so a path, a hit and a
  citation name one thing.
- **Extracted text gets `.md` appended** (`Brandschutzkonzept_Hubergasse14.pdf.md`).
  The stock `read_file` decides by extension, and a `.pdf` path that returns text is
  sent as a base64 file block (ADR-0133). Appending, rather than replacing the
  extension, keeps the original name whole in the path, so dropping `.md` gives the
  citation stem. There is one entry per document: the original is not listed beside
  its text. `read_file` accepts the bare `<name>.pdf` and answers with the text,
  naming the `.md` path in its header. Files that are text already (txt, md, csv)
  keep their own name.
- **A rename** (`display_name`) shows on the `ls` row and resolves in `read_file`;
  the path keeps the file name and does not move.
- **Duplicates.** A file name is unique per collection
  (`uniq_documents_live_name_per_collection`), so inside one collection the leaf
  identifies a document and the folder part is a hint: a stale folder still
  resolves, with "moved to …". A restricted folder is its own collection, so the
  same leaf can exist there and beside it; the folder part decides, and without it
  the listable one wins. The same name on two shelves is two paths, which is what
  the qualified citation key already says (`x.pdf (Büroablage), p.9`).
- **Agent-filed documents** (`filename = 'piloti/<name>'`) appear as `<name>` in
  their folder; no `piloti/` directory exists.
- **Matching** for `glob` and resolution is case-insensitive, NFC, and folds ä→ae,
  ß→ss (the existing `browse.fold`), so `Plaene` finds `Pläne`.
- **Canonical form.** Absolute POSIX paths only; `..`, percent-encoding and a
  relative path are refused before any lookup. A path never contains a collection
  id: admission's text backstop greps for `proj_…_r<hex>`, and a path that carried
  one would be withheld.
- **Fassungen.** The current version is the default. An older same-name version is
  listed by `ls` on the document's row (`Fassung 2 of 3`, *illustrative*) and is not
  readable until its text is stored (ADR-0134, from the day it lands or its
  backfill); the refusal names `list_files(revisions_of=…)` and compare as the way
  on. Cross-name Fassungen (EP-01 Index A and Index B, linked by `superseded_by`,
  ADR-0099) are two files, both listed, the older marked `ersetzt durch
  EP-01_Grundrisse_Index-B.pdf`; `grep` searches both and marks matches in the older
  one; `knowledge_search` keeps hiding it.

## 2. How each kind of document appears

| Kind | Path | `read_file` returns | Address | Citable |
|---|---|---|---|---|
| PDF with a text layer | `<name>.pdf.md` | one grounding block per page, from `_text/pages.md` (ADR-0134), tables inline once, running headers and footers stripped | `pages`, `clause` | yes |
| DOCX, PPTX | `<name>.docx.md` | as PDF, from the `_render.pdf` rendition's pages ([ADR-0071](../adr/0071-word-and-presentation-files-are-indexed-from-their-rendition.md)) | `pages` | yes |
| Scan | `<name>.pdf.md` | as PDF; the header says "transcribed by a vision model" | `pages` | yes |
| Drawing page | `<name>.pdf.md` | the vision model's reading, `Content Type: drawing`, under a header line: a reading of the sheet, not its printed text; read off, not measured; `look` shows it | `pages` | yes, as today; a number quoted from it is `observed` only when it comes from `look` |
| txt, md, csv | own name | the original bytes, real lines, one block per window (`page: None`) | `offset`, `limit` in lines | yes |
| Image, photo | `<name>.jpg.md` | the caption and `capture.captured_at`, never coordinates | none | yes, the caption |
| IFC model | `<name>.ifc.md` | a summary from `bim_models` (storeys, type counts, totals) and the way to `ifc_query` and `ifc_measure` | none | **no**: a measurement is not a source |
| Folder card | `README.md` in each folder | the tier-1 abstract and key facts with the tier-0 counts ([ADR-0127](../adr/0127-search-finds-list-orients-read-reads.md)) | none | **no**: an index; a key fact is read back from its document |
| Draft | `/drafts/<name>.md` | the stock rendering, lines, because it is edited | `offset`, `limit` | no: a draft is never evidence |

`offset` and `limit` keep the meaning models expect, lines, on files that have lines.
On a paginated document the description says "use `pages`", and a call that passes
`offset`/`limit` there gets the pages they map to, with a note.

Until a document's pages are stored, `read_file` rebuilds them from chunks (the
existing `read_passage` path, de-overlapped, breadcrumbs stripped) and says so in the
header: "rebuilt from the index; page breaks inside a passage are approximate".

## 3. The tools

Standard names and argument names first; our extensions after them. Every tool
answers within the budgets the knowledge layer already uses.

### `ls(path, depth=1)`

Lists one folder (`depth` up to 4 gives the tree, today's `list_files(view="tree")`).
Each folder line carries its tier-0 card counts; each file line its pages, Dokumentart,
Plankopf Index and date. Pages of 40 rows, 100 at most, and it says how many it left
out. An index, never evidence.

```text
/project/  Aufstockung des Wohnhauses in der Hubergasse · 12 documents in 7 folders (folder counts illustrative)
  About: Unterlagen der Einreichung; Bescheid MA 37 liegt vor; Brandschutzkonzept liegt vor. (folder card, written 2026-10-20; an index, not a source)
README.md                 the folder card
Behörde/                  2 documents · Bescheid_MA37_Baubewilligung.pdf.md · Bebauungsbestimmungen_Hubergasse14.pdf.md
Einreichung/              1 subfolder (Pläne/ 3) · newest by Plankopf: EP-01 Index B
Gutachten/                1 subfolder (Brandschutz/ 1)
Not listed here: files still being read (1). Restricted folders are not listed.
Next: ls a folder, glob by name, grep for wording, read_file to read.
```

### `glob(pattern, path=None)`

File names, `* ** ? [abc] {a,b}`, with the matching rules of §1. Returns absolute
paths with one-line rows, capped at 100 with a truncation note. An index.

```text
2 files match "**/*Brandschutz*" in /project (12 searched):
/project/Gutachten/Brandschutz/Brandschutzkonzept_Hubergasse14.pdf.md   14 pp · Brandschutzkonzept
/project/Nachbarn/Brandschutzgutachten_Hubergasse16.pdf.md               Gutachten (folder illustrative)
An index, not a source: read_file to read, grep for wording.
```

### `grep(pattern, path=None, glob=None, output_mode="files_with_matches", max_count=None, mode="exact", stemmed=False, context=0)`

Wording, not meaning. `mode="exact"` (the default) matches the pattern literally,
folding case, ä/ae, ß/ss, soft hyphens and line-break hyphenation, with a 2–3-character
pattern matched as a whole word only. `mode="regex"` opts into a regular expression
under the `regex` package's timeout, as `knowledge_search(match="regex")` does today.
`exact` is the word ADR-0132's row and today's `match="exact"` already use, so one
concept keeps one word. `stemmed=true` adds inflected forms through the Snowball German
field. `context` (0 to 3) adds lines around a match.

| `output_mode` | Returns | Citable |
|---|---|---|
| `files_with_matches` | per file: count and pages, plus the denominators per mount ("12 files searched in /project, 1 with a match; /law/oib not searched") | no: an index |
| `content` | the matched passages as grounding blocks (up to 8, round-robin over files), then the lines around them as `<path>#page=<N>` lines | the passages |
| `count` | occurrences per file | no |

```text
grep("Fluchtweg", path="/project/", output_mode="content")

## Matches for "Fluchtweg" in /project: 3 occurrences in 1 file (12 files searched; case, ä/ae, ß/ss and hyphenation folded)
/project/Gutachten/Brandschutz/Brandschutzkonzept_Hubergasse14.pdf.md: 3× p.3, 7, 11

--- Result 1 ---
Source: Brandschutzkonzept Hubergasse 14
Path: /project/Gutachten/Brandschutz/Brandschutzkonzept_Hubergasse14.pdf.md
Shelf: project
Ordner: Gutachten/Brandschutz
Page: 3
Citation: Brandschutzkonzept_Hubergasse14.pdf, p.3
Content Type: text

2. Bauliche Maßnahmen
2.1 Rettungsweg
Der Fluchtweg aller Wohnungen führt über das bestehende Stiegenhaus ins Freie. …

--- Result 2 --- (p.7)   --- Result 3 --- (p.11)

## Lines around the matches
/project/Gutachten/Brandschutz/Brandschutzkonzept_Hubergasse14.pdf.md#page=3 [2.1 Rettungsweg]:
> Der Fluchtweg aller Wohnungen führt über das bestehende Stiegenhaus ins Freie. Das Stiegenhaus bleibt der einzige
Cite the passages above, not these lines.
```

A miss keeps today's wording, with the path for the collection count:
`No match for "Sprinkler" in 12 files of /project. A solid no for the WORDING, not the
topic: knowledge_search finds it by meaning.`

**Two stages, and never a silent miss.**

1. **Candidates.** A Qdrant `MatchText` filter on `text` (and on `text_stem` when
   `stemmed`) for the literal tokens every match must contain, under the scope filter
   ([ADR-0116](../adr/0116-retrieval-scope-is-a-payload-filter-compiled-in-one-place.md)),
   proposes (document, page) pairs. This is `qdrant/retrieval.find_text`'s pre-filter
   today.
2. **Verification.** The pattern runs on the stored page text (ADR-0134), read by a
   range request through `index.json`. A breadcrumb is not in a page, so it cannot
   match, and a page is counted once, so the overlap cannot double a count. Before
   backfill, verification runs on chunk text with the overlap removed and the
   breadcrumb stripped (ADR-0133 slice 1).

Stage 1 may only narrow when it is a superset of the true matches. The `word`
tokenizer cannot prove that for a pattern that is part of a token (`Fluchtweg` inside
`Fluchtwegbreite`), a pattern with no literal token, or a regex. Then grep reads the
scope's stored pages directly, within the existing deadline (`USER_REGEX_SCAN_SECONDS`,
3 s) and a document cap. Whatever it could not serve (the deadline passed, a mount
failed, a document is neither stored nor indexed) it names: `incomplete: 4 documents
in /office not searched (deadline)`. An incomplete search is never rendered as "no
match". Claude Code shipped exactly that bug: it once reported a rejected pattern as
`No files found` while the text existed (tools reference, fetched 2026-10-27).

### `read_file(file_path, pages=None, clause=None, offset=0, limit=100)`

`pages` takes `"3"`, `"3-5"` or `"3,7,11"`; `clause` takes a Punkt (`"3.5.2"`) on a
Punkt-structured document. Without either, it returns the opening page and the
Gliederung, as `read_passage` does today. One read stops at 24,000 characters (about 6k
tokens, today's `_MAX_READ_CHARS`), and the trailer names the next call. Every block is
one page, rendered by `render_grounding_block`; the preamble and trailer are the block's
own.

```text
read_file("/project/Gutachten/Brandschutz/Brandschutzkonzept_Hubergasse14.pdf.md", pages="3")

/project/Gutachten/Brandschutz/Brandschutzkonzept_Hubergasse14.pdf.md, page 3 of 14. Each block is one citable passage; cite its Citation line.

--- Result 1 ---
Source: Brandschutzkonzept Hubergasse 14
Collection: proj_files_eval
Shelf: project
Ordner: Gutachten/Brandschutz
Page: 3
Punkt: 2.1 Rettungsweg
Citation: Brandschutzkonzept_Hubergasse14.pdf, p.3
Content Type: text

2. Bauliche Maßnahmen
2.1 Rettungsweg
Der Fluchtweg aller Wohnungen führt über das bestehende Stiegenhaus ins Freie. Das Stiegenhaus bleibt der einzige
vertikale Rettungsweg; die Aufstockung erhält keine zweite Stiege.
Die Rettungsweglänge von der Wohnungseingangstür bis zum Stiegenhaus beträgt im 3. Obergeschoß höchstens 12 m.

Read page 3. Next: pages="4-6". The Gliederung: read_file without pages.
```

A drawing (*illustrative*: the fixture holds no drawing named this):

```text
read_file("/project/Einreichung/Pläne/Einreichplan EG.pdf.md", pages="1")

…/Einreichplan EG.pdf.md, page 1 of 4. A drawing: the text below is a vision model's reading of the sheet, not its printed text. Read off, not measured; look(document="Einreichplan EG.pdf", page=1) shows it.

--- Result 1 ---
Source: Einreichplan EG
Page: 1
Citation: Einreichplan EG.pdf, p.1
Content Type: drawing

[DRAWING from page 1]
Floor plan 1 of 1, Erdgeschoß (Scale 1:100)
Spaces: Stiegenhaus, Fahrradraum (14 Stellplätze), Müllraum …
Annotations: 2,45, 1,20 x 2,10, T30-RS …
```

The law: `read_file("/law/oib/oib-rl_2_ausgabe_mai_2023.pdf.md", clause="3.5.2")`
returns one block with `Punkt: 3.5.2` and `Citation: oib-rl_2_ausgabe_mai_2023.pdf,
p.12` (page *illustrative*). `ls("/law/oib/")` stops at the document level; a Punkt is
never a node. Which edition binds depends on the Land, and the listing says so.

A missing or restricted path: `No file "/project/Personal/Vertrag.pdf.md". Did you
mean …` with suggestions drawn only from listable rows.

### `knowledge_search(query, path=None, …)`

The ranked meaning search, unchanged in name, ranking, rerank and the round-0 prefetch.
It gains `path`, which compiles to the same scope as `grep`'s, and each hit gains a
`Path:` line, so the model can `read_file` around it. The `folder`, `shelf` and
`file_name` arguments stay accepted while the aliases live. Its `match="exact"|"regex"`
modes become `grep`.

**Scope by path is advised, never automatic.** Neither tool narrows on its own: without
`path` a call covers every mount the person may see. The folder or document open in the
UI reaches the turn context as a hint ("the person has `/project/Einreichung/Pläne/`
open"), and the model decides. Only permissions narrow automatically.

## 4. Citations

- **The key does not change.** `<file_name>, p.N`, qualified per shelf when one name came
  from two shelves. A path is how the model finds a file, not what it cites; the registry,
  the UI chips, stored turns and the „Bereits gelesen“ digest parse the key. `#page=N`
  appears only in grep's index lines.
- **One block per page, no line gutter in a body.** Quote verification compares against
  the body, so a gutter would break a quote that crosses a line and become "evidence".
- **The records ride on `ToolMessage.artifact`.** The backend appends a `GroundingHit` per
  block to a per-call `ContextVar`; an outermost `awrap_tool_call` opens the collector,
  awaits the call and sets `artifact` on the result. Eviction keeps `artifact`, and
  parallel calls keep separate collectors (prototype, ADR-0133). Source capture reads the
  artifact first, then today's text lookup
  ([ADR-0061](../adr/0061-a-grounding-hit-is-a-record-and-the-text-is-its-rendering.md)).
- **Replay reads text.** `read_file` and `grep` register text parsers
  (`register_source_parser`), or a replayed turn's citations vanish. Once `read_file`
  joins the capture set, a draft read is parsed too and must register nothing; a test
  pins it.

## 5. Privacy

ADR-0088's rule, listing is not use, carries over unchanged.

| Call | Restricted document | Rule |
|---|---|---|
| `ls`, `glob` over its folder | absent; the card counts nothing from it; a folder with no listable file is itself omitted | listing is not use |
| `read_file` on a guessed path | `No file "…"`, the same text as a real miss | nothing confirms it exists |
| `read_file` on a path from a search hit | reads; the collection is reported and the result admitted or withheld at round end | reading is use |
| `grep`, `knowledge_search` | include the drawable restricted collections; the row counts them only when `may_name` | as today |
| A disabled data source | an explicit refusal for `/project`, `/office`, `/chat`, `/law`; `/drafts` still works | the toggle is the person's own choice, so saying so is fine |

**The backend is the boundary.** Deep Agents' `FilesystemPermission` filters inside the
stock tools and only after the backend has searched, and the read-only SeaweedFS
credential can read the whole bucket. So no object is ever resolved from a
model-supplied path: a path resolves to a document through the turn's scoped inventory,
then document → version → storage key through the scoped lookup. A path outside the
signed scope does not exist; it never answers "permission denied", because that would
confirm the file.

The tree comes from inventory rows (`without_restricted`), as `list_files` builds it
today. Empty folders and folder descriptions need the BFF's tree, and a folder name is
itself a name, so that waits for a route that filters for the conversation's whole
audience (slice 7).

## 6. Herleitung and wire

| Call | Row verb ([ADR-0132](../adr/0132-the-herleitung-shows-the-work-one-row-per-call.md)) | `mode` | `target` | counts |
|---|---|---|---|---|
| `ls(path)` | `list` | | folder path | files, folders |
| `glob(pattern, path)` | `list` | | `path · pattern` | files |
| `grep(pattern, path)` | `search` | `exact`, `regex` | path | hits, documents, searched |
| `knowledge_search` | `search` | `meaning` | path or shelf | as today |
| `read_file` (estate) | `read` | | file name, only when `may_name` | blocks, pages |
| any call on `/drafts/` | **no row**; the draft status line as today | | | |

- **`mount` on the wire.** `ToolStep` stores only the tool's name (`wire_v2.py`), and the
  UI maps `read_file` and `ls` to the draft chip (`executed-steps.ts`). The step gains a
  typed, optional `mount: "drafts" | "project" | "office" | "chat" | "law"`; missing
  means `drafts`, which every stored turn is.
- **Repeat-fetch guard.** Estate `read_file` (path, pages, clause) and `grep` are signed;
  `/drafts/` never is, since a draft read after `edit_file` is not a repeat.
- **Per-mount source toggles.** `ls` and `read_file` serve both drafts and the estate, so
  the disabled-source refusal moves from per tool to per mount.

## 7. Building it on Deep Agents

Pinned to an exact version: 0.7.30 installs on today's LangChain stack, 0.7.32 needs
`langchain>=1.4.7`, `langchain-core>=1.7.0`, `langsmith>=0.14.12`.

| Piece | Ours | Deep Agents, reused |
|---|---|---|
| Tool names, base schemas, path validation, pagination header, truncation | | `FilesystemMiddleware`'s tools, built and bound into Piloti's tool node as the draft verbs are |
| `mode`, `stemmed`, `context` on `grep`; `pages`, `clause` on `read_file` | schema subclasses and a short wrapper around the stock coroutine; extra arguments travel in a `ContextVar`, because `CompositeBackend.agrep` forwards only `pattern, path, glob, max_count` | `GrepSchema`, `ReadFileSchema` |
| Result text of `read_file` and `grep` content | grounding blocks, rendered by us | |
| Search, scope, tenancy, page text, the scoped lookup | an async read-only `BackendProtocol` implementation over the knowledge layer and ADR-0134's store; tenant and scope from `get_runtime().context` | `BackendProtocol`, `slice_read_response`, `ReadResult` invariants |
| Routing and `/drafts/` | | `CompositeBackend`, `StoreBackend` |
| Citations, Herleitung rows, Langfuse spans | the outermost `awrap_tool_call` and the collector | `artifact` survives eviction |
| Large results | `artifacts_root="/drafts/"` | eviction |
| Descriptions | the texts, in English | `custom_tool_descriptions` |

The traps the prototype found (Deep Agents 0.7.32, scripted model, 2026-10-27), each a
rule:

1. **A tool with a taken name replaces the stock one silently.** The last bound tool of a
   name wins and nothing warns, so a test asserts which implementation each name runs.
2. **A `.pdf` path through the stock `read_file` is a base64 file block**, even when the
   backend returns text. Hence `.pdf.md`.
3. **`CompositeBackend` always offers `delete`.** The tool allowlist excludes it, and
   `execute`.
4. **Eviction to a read-only backend fails silently**, and a 227,779-character result
   stayed in context. `artifacts_root` is `/drafts/`. Our own `grep` and `read_file` are
   exempt from eviction by name, so they truncate themselves.
5. **Tool-level permissions filter after the search.** The backend is the boundary (§5).
6. **A root search fans out route by route, sequentially, and one route's error aborts
   it.** The backend returns partial results with `truncated=True`, which grep renders as
   `incomplete`.
7. **A native `agrep` gets no timeout**; the default wrapper's 35 s applies only to the
   sync fallback. Ours sets its own.
8. **The stock grep formatter sorts by path**, so ranked results never go through it.
9. **A subclass of `FilesystemMiddleware` must keep that name**, or `create_deep_agent`
   appends it beside the stock one.

Not taken with it: summarization (off for chat; it moves the cached prefix), Anthropic
prompt caching (applies only to `ChatAnthropic`; our models run through OpenRouter, and
our own caching stays), the general-purpose subagent, `write_todos`.

## 8. What retires, what folds, what stays

| Today | Becomes |
|---|---|
| `list_files` | `ls` and `glob`. `revisions_of` and `compare_to` stay on `list_files` until a revisions surface exists |
| `read_passage` | `read_file` with `pages` and `clause` |
| `knowledge_search(match="exact"\|"regex")` | `grep` |
| draft `ls`, `read_file`, `write_file`, `edit_file` | the same tools, on `/drafts/` |
| `knowledge_search` (meaning) | stays, with `path` |
| `look`, `ris_lookup`, `web_search_tool`, `ifc_query`, `ifc_measure`, `project_lookup`, `workspace__*`, `canvas__*` and the write tools | stay |

Since slice 6 the old names are off Piloti's chat binding: a call to one is answered with
the exact replacement call (`common/retired_calls.py`), and `list_files` stays bound with
`revisions_of` and `compare_to` only. They stay registered, because stored and replayed turns
name them, the read side reads them for good, and the answer suite's matcher maps old to new so
before and after compare. The MCP door keeps its operations (`files-list`,
`passage-read`, `knowledge-search`) and gains `path`. Deep research and intake keep the
old names until each is measured on the new ones; deep research never mounts the estate
as a backend route.

## 9. Slices

Each measured on `task be:eval:answer-suite -- --set files` before and after, with the
arms grep only, semantic only and hybrid (`--arm all`, with `--baseline` or `--compare`
for the before/after table; [the files set](../contributing/testing-and-verification.md#the-answer-suite)).
The rows match the old and the new tool names alike, so one row set measures every slice.
The table with what each reads off the suite is in ADR-0133's More Information.

0. A realistic fixture document cut by the real section chunker.
1. Grep's double count in the overlap and breadcrumb matches, fixed inside today's tool.
2. `read_file` for the estate over stored pages, chunk rebuild as fallback; `mount`.
3. `ls`, `glob`, folder cards as `README.md`, the mount digest in the prompt.
4. `grep` under its own name.
5. `/law/oib/`, `/office/`, `/chat/`; `knowledge_search(path=…)`.
6. The prompt around four verbs; aliases retired.
7. The audience-aware BFF tree route.

## 10. Open questions

1. **`README.md` against a real one.** When the office keeps its own `README.md` in a
   folder, the document keeps the name and the card is only inline in `ls`. Is that
   enough, or does the card need a name nobody uses?
2. **The address of an older Fassung.** A suffix (`…pdf.md@2`) or a `version` argument on
   `read_file`?
3. **Line numbers within a page.** Stored pages make `path#page=12:L7` addresses possible
   in grep's lines. Worth it, or noise for a model that cites pages?
4. **The superset rule for grep's stage 1** needs a test per tokenizer case (whole token,
   part of a token, digits, `§`), and a measurement of how often a project-scope scan of
   stored pages hits the deadline.
5. **`/projects/<id>/` on the door**, if outside agents get this projection.

## 11. Prior art

| Source | Date | What it showed |
|---|---|---|
| Mintlify, [How we built a virtual filesystem for our assistant](https://www.mintlify.com/blog/how-we-built-a-virtual-filesystem-for-our-assistant) | 2026-03-24 | `just-bash` over Chroma: the tree as a cached manifest, `cat` rebuilt from chunks, grep as a coarse `$contains`/`$regex` filter then exact matching, permissions pruned before the tree is built; boot 46 s → 100 ms; 30,000+ conversations a day. Its corpus is Markdown |
| Upstash, [Building a really fast virtual filesystem for AI agents](https://upstash.com/blog/redis-virtual-fs) | 2026-04-20 | The same shape on Redis, full content per file, grep as a full-text query; read-only by choice |
| Cursor, [Improving agent with semantic search](https://cursor.com/blog/semsearch) | 2025-11-06 | +12.5 % average QA accuracy with semantic search beside grep; "the combination … leads to the best outcomes" |
| Cursor, [Fast regex search](https://cursor.com/blog/fast-regex-search) | 2026-03-23 | An n-gram index proposes, the text decides; "false positives are always acceptable" |
| Microsoft, AgenticRAG, [arXiv 2605.05538](https://arxiv.org/abs/2605.05538) | 2026-05-07 | `search`/`find`/`open` over enterprise search: 92.0 % on FinanceBench against 24.24 % RAG and 32.71 % keyword-only, at 7.8× the tokens |
| PwC, Is Grep All You Need?, [arXiv 2605.15184](https://arxiv.org/abs/2605.15184) | 2026-05-14 | The harness moved accuracy as much as the retriever; file-delivered results flipped 5 of 10 pairs |
| Vercel, [We removed 80% of our agent's tools](https://vercel.com/blog/we-removed-80-percent-of-our-agents-tools) | 2025-12-22 | 17 tools to one bash tool, on five queries, "because our semantic layer was already good documentation" |
| Vercel, [How to build agents with filesystems and bash](https://vercel.com/blog/how-to-build-agents-with-filesystems-and-bash) | 2026-01-09 | Raw uploads beside their extracted text |
| Anthropic, [Building agents with the Claude Agent SDK](https://claude.com/blog/building-agents-with-the-claude-agent-sdk) | 2025-09-29 | Start with agentic search, add semantic search when needed; folder structure is context engineering |
| Anthropic, [Effective context engineering for AI agents](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents) | 2025-09-29 | Just-in-time retrieval by identifier; hybrid "better suited for … legal or finance work" |
| Claude Code, [tools reference](https://code.claude.com/docs/en/tools-reference) | fetched 2026-10-27 | `Read` with `pages` for PDFs; `Grep` output modes; the false "No files found" bug |
| Boris Cherny on [Latent Space](https://www.latent.space/p/claude-code) | 2025-05-07 | Claude Code left vector RAG for agentic search, on evidence he calls "mostly vibes", over code |
| Harvey, [Agentic Vault search and organization](https://www.harvey.ai/blog/agentic-vault-search-and-organization) | 2026-09-08 | Folder, naming and uploader as navigation signals; the agent has the person's permissions; every file touched is logged |
| Deep Agents 0.7.32 source and changelog | 2026-10-23 | `BackendProtocol`, `CompositeBackend`, the stock tool formats, the eviction rules, 32 patch releases in about 13 weeks |
