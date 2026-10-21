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

What each scene sounds like in a single turn, with the ideal trajectory, the
answer and the checks that hold it: [`north-star-answers.md`](north-star-answers.md).

**Restraint that survives the star:** the answer shows what supports it, not
everything that happened. The crop that proves the point is a card; every other
glance is a line in the Herleitung.

## Where we stand

Evidence for each row: the audits of 2026-10-21 (file use, Qdrant, visual
inspection) and the research behind ADR-0127 and ADR-0128.

| Capability | Today | Weakness, with evidence | Landing |
|---|---|---|---|
| Find by meaning (retrieval) | **Strong.** Dense plus German BM25 fused by RRF in Qdrant, cross-encoder rerank, sufficiency requery, tenancy enforced in one filter constructor; `group_by="document"` answers which documents deal with X; `document_date` and `added_at` are datetime payload with range filters; BM25 length measured per collection | Recency and date range are in the payload, not yet offered as tool arguments; the measured BM25 length takes effect only after a collection is rebuilt | ADR-0127: date arguments once an eval row asks a dated question |
| Orient in a project (star 1) | **Built, partly off.** `list_files(view="tree", depth=1-4)` gives a card per folder: counts, Dokumentart mix, current Fassung, page counts, computed on read. Written cards (abstract and up to 8 cited key facts) are built bottom-up from the children, incrementally from the diff, behind `GRID_FOLDER_CARDS` (off) | Written cards never switched on in an office or measured; a card lags its folder by the debounce (10 minutes or 60 changes) | ADR-0127: switch on, then the `files` eval before and after |
| Read a document through (star 2) | **Strong.** `read_passage(pages="4-6")` reads a page range in reading order and returns a `cursor` to continue | Extracted text still exists only as chunks, so a page with no chunk (a pure drawing) reads as empty and needs a look | ADR-0127 |
| Find an exact phrase (grep) | **Strong.** `match="exact"` or `"regex"`, `context=N` lines, `folder=` scope, `stemmed=true` for German word forms | The regex scan stops at 20,000 chunks or 3 seconds and says so | ADR-0127 |
| Choose between search, browse and read | **Taught, not yet measured.** The prompt's `<sources>` teaches three moves (search finds, list orients, read reads) with a worked example of a ranged read, of list then exact search then read, and of a look; round 0 still prefetches a search | No `files` eval run yet before and after the prompt change | ADR-0127: three moves taught with when-to-use rules and examples; retrieval stays round 0 |
| Look at a region (star 3) | **Strong in every context.** `look`, one tool for chat, canvas and the door (`document-look`), renders any region up to 1200 dpi; `question=` returns a reading from the vision model; six looks a turn, two of them overviews; the box glows for everyone who has the document open | The standing look policy in the prompt (before a value off a drawing, a figure, an image-only hit, a Fassung comparison, a drawn box) is unmeasured until the `visual` eval runs | ADR-0128: the `visual` eval set before and after |
| Point and show (star 4) | **Built.** A look the answer rests on stays as a card with the highlighted region (kept: looks at a cited document, else all); citations render as places with a page thumbnail; `canvas__point`, `canvas__highlight` and `canvas__mark` while a document is open | A card shows one region; no side-by-side crops of two Fassungen yet | ADR-0128 |
| Chat and canvas as mirrors | **Checked.** `surface-parity/parity.config.ts` registers each capability per surface, and its spec fails CI when a canvas op, catalog operation or canvas tool has no entry, and when a recorded gap is already closed; pointing and highlighting reach the chat on the look card | Two gaps stay open: a Fassung comparison has no card or thumbnail pair in the chat, and a chat question about an open document does not carry the person's selection | ADR-0128, slice V10 |
| Compare Fassungen visually | **Partial.** `document-revision-compare` returns boxes and sentences for one page pair; the revision notice (ADR-0130) runs it unasked | Text and boxes only, no side-by-side crops in the chat, uses the ingest model | ADR-0128, slice V10 |
| Show its working (star 6) | **Partial.** Herleitung shows searches, reads and each look as a step with its thumbnail | The steps read as tool calls, not as a colleague's notes | Herleitung wording is a later pass |
| Notice unasked (star 5) | **Partial, behind a switch.** A Fassung linked to an older one queues a notice: the changed pages (from the index, no model) are compared visually and each change becomes a proposed mark on the new Fassung, with one thread message and one inbox row for the person who made it; off unless the office has `piloti-notices` | Visual only: nothing checks the changed values against the Brandschutzkonzept or the Bebauungsplan; a same-name version is not noticed; at most three pages; the vision call is not booked to the budget; no eval row runs it yet | ADR-0130: the visual slice now; the cross-document check as a headless turn next |
| Learn the office (star 7) | **Partial, built off.** `remember` keeps durable facts; a deterministic count of the office's conventions (folders its projects keep, where each Dokumentart is filed, Plannummer shape, Index style, date in file names) reaches the WORKSPACE block on filing and finding questions, behind `GRID_OFFICE_CONVENTIONS` (off) | Never switched on or measured; no Dokumentarten per phase (no per-document phase); no drawing conventions beyond the title block (Maßstab, layers, symbols); a person cannot yet see, confirm or decline a line; accepted proposals do not count as confirmation | ADR-0129: a read view, then confirm or decline, then an `ns-learn-office` eval row |
| Measured | **Built, not yet run.** Eval sets `files` (`pf-*`, arms search, navigate, both), `visual` (`pv-*`, drawings rendered from a spec, scored by IoU and coverage) and `north-star` (`ns-*`) exist and their fixtures are checked in CI | No run yet: the answer suite needs model credit and a Qdrant corpus | Run all three before and after; record the numbers here |
