---
status: proposed
date: 2026-10-30
decision-makers: Grid engineering
consulted: the S4 spike (r3) and the outline eval (r4)
informed: everyone working in this repo
---

# The server draws a sketch's picture from its scene

Amends [ADR-0148](0148-a-sketch-is-a-document.md) („the picture and the scene can
disagree“) and the trust section of [`diagrams.md`](../architecture/diagrams.md).
The slices: [`docs/roadmap/sketches.md`](../roadmap/sketches.md), S4.

## Context and Problem Statement

A Skizze is an SVG carrying its Excalidraw scene (ADR-0148). Until now a save sent
both, `{ scene, svg }`, and the server stored the SVG the client drew: the preview and
the PDF showed the picture, the outline and the editor the scene, and nothing on the
server could check that they agreed. For the editor that was the writer's own
integrity. For an agent it is a real gap. `document-sketch-update` asked Claude or
Piloti to send an `exportToSvg` picture it cannot make, and S4 (Piloti edits a
Skizze) has no browser at all: the edit is applied on the server under the person's
yes.

`diagrams.md` gave the reason the server did not draw: Excalidraw needs a DOM and a
canvas to lay out text, and there is no browser in the production image. The spike
(r3, 2026-10-29) tested that claim.

## Decision Drivers

* One scene, one picture: the preview, the PDF, the outline and the editor show the
  same drawing, whoever saved it.
* Never set browser globals in the Next server process: every `typeof window` check
  there would lie.
* Buy, don't build: Excalidraw's own `exportToSvg`, not a second renderer.
* A text the server lays out must get the width the editor would give it, or a
  label overflows its box in the filed picture.
* No new native dependency in the image unless the numbers need one.

## Considered Options

1. **Keep the client's SVG** and add a cheap consistency check.
2. **Headless Chromium** (Playwright) in the image.
3. **Excalidraw in a `worker_thread`**, on happy-dom with a stub canvas, from a Node
   bundle built at build time; text measured from the font files.
4. As 3, with **@napi-rs/canvas** (a native canvas) for text measurement.

## Decision Outcome

Chosen option 3.

* **The worker.** `bff/diagrams/sketch-render-worker.ts` installs happy-dom (a
  stub 2D context, `Path2D`, `document.fonts`, a `fetch` that refuses everything) on
  its own globals, then imports Excalidraw and calls `exportToSvg` with the editor's
  settings (paper, padding 16, fonts not inlined), then the same cleaning and
  validator the browser path uses (`fileableSketchSvg`, moved down into
  `bff/diagrams/sketch-svg.ts`). `installSketchDom` throws on the main thread.
* **The bundle.** `scripts/build-sketch-renderer.ts` bundles the worker with
  Excalidraw, happy-dom (a devDependency, so it is inlined) and fontkit into
  `dist-sketch-render/sketch-render-worker.mjs` (9.5 MB, 1.4 s), with
  `font-coverage.json` beside it. Plain Node cannot import Excalidraw itself (it
  names `roughjs/bin/rough` without an extension). `bun run build` and `dev:next`
  run it after `copy-excalidraw-assets.mjs`; the Dockerfile copies the folder; the
  client bundle and `next build` never see it. Bun builds it, as it builds the jobs
  bundle and the MCP Apps views (ADR-0103), instead of a separate esbuild step.
* **The bounds** (`sketch-renderer.ts`): one worker, one render at a time, 16 queued
  (one more is a 503 `busy`), a 10 s deadline that terminates the worker, a 384 MB
  old-generation cap, ended after 5 minutes idle.
* **The save** (`PUT /api/documents/{id}/sketch`) takes `{ scene, baseVersionId }`;
  an `svg` field is dropped unread. The stored picture, and the PDF drawn from it, are
  always the server's. A render that fails is a 503 and scores `sketch-save:
  render_failed`; each save's score carries `render_ms`, `render_elements` and
  `remeasured`.

### Text measurement

Excalidraw stores each text's `width` and `height` from `ctx.measureText`.
Excalidraw 0.18 has a seam for that, `setCustomTextMetricsProvider`, and the worker
fills it with `sketch-text-metrics.ts`: advance widths from the same woff2 files the
editor loads (`public/excalidraw/fonts`), read with fontkit, kerned within a word and
not across a space (as Chromium shapes words), each character in the first
unicode-range chunk that has it. Helvetica, every label Piloti writes, is Excalidraw's
local font and resolves on every platform to a face with Helvetica's advance widths,
so it is measured with Liberation Sans, which Excalidraw ships.

Measured 2026-10-30 against Chromium 153's canvas over 100 strings (German labels,
umlauts, ß, dashes, arrows, quotes; Helvetica at 16, 20 and 28 px, Excalifont at 20
and 36 px; `bff/diagrams/__fixtures__/sketch-text-widths.json`): **largest difference
0.0005 px**. A width costs 0.13 ms uncached. So @napi-rs/canvas (option 4, a 31 MB
native binary, exact only when the right font chunk is registered) buys nothing here.

Only texts a save adds, or changes in a field that decides their layout, are laid out
again (`sketch-picture.ts`, `textsToMeasure`); the rest is drawn as the editor
measured it. Two findings on the way, both in `docs/contributing/gotchas.md`:
Excalidraw applies `refreshDimensions` only together with `repairBindings`, and the
first character outside Excalifont (a `²`) decoded all 209 Xiaolai chunks (600 ms),
which the build's coverage index avoids.

### The font-load race

The spike saw `convertToExcalidrawElements` store fallback-font widths when it ran
before Excalifont had loaded (76.09 px for „Zugang 4“ instead of 91.54 px), never
refreshed. Checked in the app: every text Piloti or the chat creates is Helvetica
(`SKETCH_FONT_FAMILY = 2`, `sketch-fence.ts`, `sketch-from-model.ts`), a local
font with nothing to load, and in Chromium the element's width equals the loaded
measurement (84.51 px both). So the race does not reach this product's texts; a
person who switches a text to Excalifont in the editor gets the editor's own refresh.
The spike's scene, which does carry the race (542.76 px stored for a title Excalifont
sets at 626.25 px), is the renderer spec's fixture, and the server's layout of it is
the loaded one: the server's measurement depends on no load.

### Numbers

Node 22, this container, 2026-10-30 (`sketch-renderer.spec.ts`, and a bench over
the fixture scene):

| | |
|---|---|
| worker start and first render | 330 to 360 ms |
| render, 40 elements | 13 ms median, 26 ms max |
| render, 150 elements (a model's cap) | 40 to 60 ms median, 75 ms max |
| 150 elements, 71 texts laid out again | 86 ms |
| render, 2 000 elements (the scene cap) | about 500 ms; that drawing's SVG is 1.4 MB, over the 1 MiB SVG cap, and refused as `too-large` as it was from the browser |
| memory | 160 to 210 MB RSS over the server's own, while the worker lives |
| output | stroke for stroke and word for word the browser's `exportToSvg` of the same scene (`sketch-scene.browser.svg`) |

### Consequences

* Good, because scene and picture can no longer disagree: the server drew one from
  the other. ADR-0148's „Bad, because the picture and the scene can disagree“ is
  closed for every save. Filing from the chat still files the browser's picture of a
  fence it drew (`fileDiagramDocuments`); moving that onto the server is the next
  caller, not a new mechanism.
* Good, because an agent's save is a scene alone, and S4's server-side edits need no
  browser.
* Good, because a text an agent writes gets the editor's width.
* Bad, because a save now costs a render on the server (tens of ms, a worker of about
  200 MB while warm) and can fail on the server's side (503), where it could not
  before.
* Neutral, because the editor still exports an SVG for filing and for its own check,
  and no longer sends it on a save.
* Open: a bound label that grows is laid out again but its container is not grown
  (Excalidraw's `redrawTextBoundingBox` is the editor's); S4's edit operations need
  it. A CJK label is measured in Xiaolai only when its chunk is staged, as all are.

### Confirmation

* `bff/diagrams/sketch-renderer.spec.ts` builds the bundle, renders the fixture scene
  in the worker and compares it stroke by stroke with Chromium's export, checks the
  server process has no `window`, the deadline and the missing bundle.
* `bff/diagrams/sketch-text-metrics.spec.ts` holds every fixture width to Chromium's
  within 0.05 px.
* `app/api/documents/[id]/sketch/route.spec.ts`: a client's `svg` is never stored,
  the PDF is drawn from the server's picture, a failed render is a 503 that saves
  nothing.
* The Excalidraw version is pinned (`0.18.1`); a bump re-runs both fixtures, and a
  changed export or metric fails them rather than a customer's file.

## Pros and Cons of the Options

### Keep the client's SVG and check it

* Bad, because no cheap check fits: an agent's hand-written SVG need not set text the
  way `exportToSvg` does, and comparing two pictures needs a renderer anyway.
* Bad, because an agent still has to produce a picture it cannot draw.

### Headless Chromium in the image

* Good, because it is the browser, exactly.
* Bad, because it adds a browser (hundreds of MB and its sandbox) to the production
  image for one export, and `playwright-core` is a devDependency today. Rejected on
  that premise: if the image ever ships a browser for another reason, it is the
  simpler renderer.

### Excalidraw in a worker on happy-dom (chosen)

* Good, because the output equals the browser's and the dependencies are already in
  the tree (Excalidraw, happy-dom, fontkit through @react-pdf).
* Bad, because a stub canvas is a contract with Excalidraw's internals: a release
  that draws an export through a canvas call the stub ignores fails the fixture spec.

### @napi-rs/canvas for text

* Good, because it is a real canvas.
* Bad, because it is a 31 MB native prebuilt per platform, and exact only with the
  right unicode-range chunk registered (the spike measured 138.56 px for 91.54 px
  with all seven Excalifont chunks under one name). Rejected on the measurement
  above: fontkit's widths already equal Chromium's to 0.0005 px. A label in a script
  fontkit shapes differently from HarfBuzz (Arabic, Devanagari) would reopen it.

## More Information

* The spike: r3, 2026-10-29 (scratch, not in the repo); its finding is the table
  above, re-measured here.
* `diagrams.md`, „Trust: what the server does with client bytes“, says what is
  trusted now.
