---
status: accepted
date: 2026-10-27
decision-makers: Grid engineering
consulted: product owner
informed: everyone working in this repo
---

# A person reworks Piloti's drawing as an Excalidraw sketch; the model still writes mermaid

## Context and Problem Statement

Piloti draws a Verfahren, a decision path or a Gliederung from a mermaid fence
in its answer, in its own views, and files it into the project as an SVG and a
PDF (`docs/architecture/diagrams.md`). An architect who wants that drawing to
say something more, such as the office's internal Freigabe step, a note on the
step they disagree with, or a box moved to where it belongs, has to redraw it
somewhere else. Nothing in Piloti lets the person's hand into a drawing.

The product owner asked for `excalidraw/excalidraw-mcp` in the app. That
repository was read at `157aa23` (2026-03-24, the latest commit on 2026-10-27).
It is an MCP App: its server parses the model's JSON, stores a checkpoint and
answers "Diagram displayed!". The picture exists only in its `ui://` iframe,
which loads React and Excalidraw from `esm.sh` at runtime. Its hosted
deployment keeps every scene in Upstash Redis, and its export uploads scenes to
`json.excalidraw.com`. It has one active author, no LICENSE file (the README
and `package.json` say MIT), and depends on `@modelcontextprotocol/ext-apps`
^0.4.0 while 2.0.4 is current. The research is in the PR.

## Decision Drivers

* Remove a step from the architect's day: rework a drawing in place and file it
  where the office looks.
* ADR-0069: a card must carry what Markdown cannot. A mermaid fence is the
  drawing a `diagram` card was, which is why that card was retired.
* The diagram doctrine (`lib/diagrams/diagram-sources.ts`): model-written
  geometry only for subjects that claim no dimension.
* Files that leave the product say who made them, in their own bytes.
* No tenant content to a third party (ADR-0074). The chat must not get heavier
  for readers who never edit a drawing.
* Buy, don't build: the editor is someone else's domain.

## Considered Options

1. **Piloti's agent calls excalidraw-mcp as an MCP client tool**, and its output
   is drawn as a card. Rejected because `create_view` returns no drawing, only a
   checkpoint id (true at `157aa23`). Showing it would mean hosting MCP Apps
   iframes in our chat, which ADR-0065 rejected. The hosted server would receive
   every drawing a turn makes.
2. **A model-emitted `diagram` card holding an Excalidraw scene.** Rejected
   because the model would place every box by absolute coordinate. That is
   worse layout than mermaid plus dagre, about ten times the tokens of the fence
   (`DIAGRAM_SOURCE_FACTS`), and the exact model-written geometry the doctrine
   confines. The premise to re-check: every non-dimensional shape Piloti draws
   has a mermaid grammar that draws (`diagrams.md`, grammar table). A
   room-relation diagram (undirected adjacency, position that means something)
   is the case that could break it.
3. **Serve excalidraw-mcp's `ui://` resource through our own MCP door.**
   Rejected because the door offers what only Piloti has (ADR-0122). Any Claude
   or ChatGPT user can already add `mcp.excalidraw.com`. Piloti's own diagrams
   as an MCP App belong to the outward A2UI-in-MCP-Apps slice, not to this one.
4. **Excalidraw's editor for the person, opened on Piloti's drawing**, filed
   through the existing diagram route. Chosen.
5. **Do nothing.** Rejected because the person's hand is the one thing the
   fence cannot give, and the filing pipeline already reserved the `excalidraw`
   source kind for it.

## Decision Outcome

Chosen option 4.

* **„Als Skizze bearbeiten"** on a drawn flow or Gliederung (the two models
  that are node graphs), inside a project. It opens `@excalidraw/excalidraw`
  0.18.1 (exact pin, MIT) in a dialog, full screen on a phone.
* **The starting scene is the model the reader saw**, not a second parse:
  `sketchFromModel` lays the parsed `FlowModel`/`MapModel` out with dagre and
  hands Excalidraw its documented skeleton format. Excalidraw's own
  `@excalidraw/mermaid-to-excalidraw` was read and not taken. It depends on
  `mermaid ^11` beside our 12, so it would ship a second copy, and it lays the
  graph out again, so the sketch would open in a different arrangement.
* **Loaded on the click and never before.** Only `sketch-canvas.tsx` imports
  Excalidraw, and only `next/dynamic` reaches it (`sketch-isolation.spec.ts`).
* **No traffic leaves the origin.** `window.EXCALIDRAW_ASSET_PATH` points at
  fonts staged into `public/excalidraw/` (`scripts/copy-excalidraw-assets.mjs`),
  because Excalidraw falls back to `esm.sh` for any font it cannot load.
  Images, embeds, its own load/save/export and the library browser are off.
* **Filed through the existing route and operation.**
  `POST /api/projects/{id}/diagrams` (`diagram-file`, already `OFFERED`) with
  `sourceKind: 'excalidraw'`, the scene as source, the SVG `exportToSvg` drew
  (cleaned and put through the server's own validator in the browser), and
  `edited: true`. No new route, permission or migration.
* **Provenance names both authors.** `edited` selects „Von Piloti entworfen,
  von einer Person bearbeitet … Skizze: nicht maßstäblich, ohne Maßangabe" for
  the SVG `<title>` and the PDF footer. The machine marking stays
  `AIGenerated=true; AIHumanReviewed=false`: editing is not a Freigabe.
* **Observable.** Every filing scores `diagram-filed` (`as_drawn | edited`) on
  the trace of the answer that drew it.
* **The model is unchanged.** No card type, no prompt line, no answer-suite run.

### Consequences

* Good, because an architect reworks Piloti's drawing in place and files their
  version with honest provenance, through a path that already had its
  authorization, quota, restricted-folder and idempotency rules.
* Good, because the chat downloads 2.4 KB gzip more (the dialog shell and the
  conversion), measured with esbuild against the new modules only.
* Bad, because the click downloads 2.46 MB gzip (8.2 MB minified, JS and CSS),
  and `public/excalidraw/` adds 14 MB of fonts to the image, 13 MB of it
  Xiaolai's CJK subsets that are fetched only for CJK glyphs but must exist so
  nothing falls back to the CDN.
* Bad, because installing it adds 115 packages to `node_modules`, `sass` 1.51
  among its runtime dependencies (not bundled).
* Bad, because Excalidraw's arrow-label mask is removed for the file (the SVG
  validator has no `<mask>`), so a label sits on its line in the filed SVG and
  PDF, not on a gap.
* Bad, because a save files a new pair of documents per distinct scene, not a
  new Fassung of the old one, and a filed sketch cannot be reopened. That is
  the next slice, if `diagram-filed: edited` shows people use it.
* Neutral: `DIAGRAM_RENDERERS.excalidraw` stays `null`. Nothing renders a
  stored scene yet, and an entry with no caller is not added.

### Confirmation

* `features/diagrams/sketch/sketch-isolation.spec.ts`: Excalidraw is imported
  by `sketch-canvas.tsx` alone, reached only by a dynamic import from the dialog.
* `features/diagrams/sketch/sketch-from-model.spec.ts`: shapes, bindings,
  layout direction, no numbers but the layout's.
* `lib/diagrams/svg-to-pdf.spec.tsx`, „real Excalidraw sketch": the bytes
  Chromium posted from `/dev/diagram-sketch` pass the validator and print.
* `app/api/projects/[id]/diagrams/route.spec.ts`: `edited` selects the
  two-author marking and scores the filing.
* `tests/aiq_agent/observability/test_langfuse_scores.py`: `diagram-filed` is
  declared and documented.
* Nothing enforces that the fonts are staged in a deploy beyond `bun run build`
  calling the script; a missing copy shows only as requests to `esm.sh`.
