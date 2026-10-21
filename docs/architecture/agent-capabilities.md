# Piloti's capabilities: the north star and where we stand

This is the register of what Piloti can do as a colleague in the office, how
well it does it today, and what closes the gap. It is written in the two passes
of [working-style.md](../contributing/working-style.md#aim-at-the-north-star-land-on-the-clouds):
the star first, with no technical limits, then the honest state underneath.
Update a row in the change that moves it.

## The north star

Talking to Piloti feels like talking to the most experienced architect in the
office.

1. **It knows every project the way the project lead does.** Open a project and
   it already has the picture: what each folder holds, what changed this week,
   what the authority is still waiting for, which plan is current and which is
   superseded, and where something does not add up. Every folder is a briefing
   that writes itself as documents arrive.
2. **It works the way a person at a desk works.** Asked whether the escape
   routes in the submission match the fire-safety report, it opens the
   submission folder, takes out the floor plans, reads the report through
   pages 12 to 18, zooms into the stairwell on plan 03, measures the corridor
   and checks it against OIB-RL 2. It comes back with "here: 1.10 m, the report
   assumes 1.20 m", the crop, the highlighted region, the passage and the
   paragraph side by side.
3. **It sees a drawing the way an architect does.** It reads dimension chains,
   counts doors, finds the stamp in the title block, and notices that a wall
   moved between two Fassungen, showing both crops with the change glowing. It
   looks without being asked, because an expert does not state a dimension they
   have not seen.
4. **It points.** In the chat, on the canvas, or answering another agent, it is
   one colleague who puts a finger on the plan. Every claim is a place you can
   click: the region on the page, opened and glowing.
5. **It notices.** A new plan arrives and it checks it against the last
   Fassung, the fire-safety report and the zoning plan, and leaves a marked note
   on the drawing where something does not fit.
6. **It shows its working like a lab notebook.** The Herleitung reads like a
   senior's notes: opened the authority folder, four documents; read the
   decision pages 2 to 3; looked at plan 03, stairwell; measured; compared with
   OIB-RL 2, 5.1.2. Auditable in a minute.
7. **It gets better at this office.** It learns where things are kept, what
   they are called and the drawing conventions in use, so the next project
   starts already oriented.

What makes it possible: retrieval is its memory; folder cards and the file tools
are its orientation and its reading; region rendering and the vision model are
its eyes; the canvas and the answer cards are its finger; the Herleitung is its
notebook; the one API and its MCP door make each of these one capability for
every client; the evals say whether we got there.

**Restraint that survives the star:** the answer shows what supports it, not
everything that happened. The crop that proves the point is a card; every other
glance is a line in the Herleitung.

## Where we stand

Evidence for each row: the audits of 2026-10-21 (file use, Qdrant, visual
inspection) and the research behind ADR-0127 and ADR-0128.

| Capability | Today | Weakness, with evidence | Landing |
|---|---|---|---|
| Find by meaning (retrieval) | **Strong.** Dense plus German BM25 fused by RRF in Qdrant, cross-encoder rerank, sufficiency requery, tenancy enforced in one filter constructor | BM25 runs on default `avg_len` (256) against chunks of about 1024 tokens; no date fields, so no recency or date range; results not grouped per document | ADR-0127: grouping by document, date payload, BM25 tuning in a rebuild |
| Orient in a project (star 1) | **Weak.** `list_files` lists a folder | A folder is a path string; no tree, no counts, no page counts, nothing derived from its children | ADR-0127: folder cards, exact facts computed on read, then a short summary built from the children |
| Read a document through (star 2) | **Weak.** `read_passage` returns up to 12 chunks | No page range, no continuation, no whole-document read for PDFs; extracted text exists only as chunks | ADR-0127: page ranges and a continuation cursor over chunks in reading order |
| Find an exact phrase (grep) | **Partial.** Literal match, per-file counts | No regex, no context lines, no folder scope, stops at 500 chunks per collection | ADR-0127: regex, context, folder scope |
| Choose between search, browse and read | **Weak.** | The prompt says "Retrieve first", every worked example is a search, and round 0 always prefetches a search; one paragraph mentions opening files | ADR-0127: three moves taught with when-to-use rules and examples; retrieval stays round 0 |
| Look at a region (star 3) | **Strong on the canvas, absent in the chat.** `canvas__look` renders any region up to 1200 dpi; the box glows for everyone in the document | The look rule is injected only when a person drew a box; nothing makes Piloti look on its own; no look survives the answer | ADR-0128: a standing look policy in the prompt, one look capability in every context |
| Point and show (star 4) | **Partial.** `canvas__point` and `canvas__highlight` while a document is open; `canvas__mark` proposes findings | Pointing is ephemeral and canvas-only; citations carry a region box that the chat never renders | ADR-0128: a card for the look that supports the answer, citations rendered as places |
| Chat and canvas as mirrors | **Absent.** | Capabilities are bound per surface; nothing checks parity | ADR-0128: a parity register checked in CI, like `exposure.config.ts` |
| Compare Fassungen visually | **Partial.** `document-revision-compare` returns boxes and sentences for one page pair | Text and boxes only, no side-by-side crops, uses the ingest model | ADR-0128 |
| Show its working (star 6) | **Partial.** Herleitung shows searches and reads | Looks never appear; the steps read as tool calls, not as a colleague's notes | ADR-0128: a Herleitung step per look |
| Notice unasked (star 5) | **Absent** | No trigger reviews a new Fassung against its context | Next horizon |
| Learn the office (star 7) | **Partial.** `remember` keeps durable facts | No learned conventions for naming, filing or drawings | Next horizon |
| Measured | **Absent for files and looking.** | `list_files` and exact search have never been measured; no eval asks a question that needs a look | ADR-0127 and ADR-0128 each start with their eval set |
