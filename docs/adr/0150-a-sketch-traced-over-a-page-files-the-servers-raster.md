---
status: proposed
date: 2026-10-30
decision-makers: Grid engineering
consulted: the S6 spike (r3), the AEC markup research (r2), the feld72 Jour fixe of 2026-10-30
informed: everyone working in this repo
---

# A Skizze traced over a PDF page files the server's own raster, in one slot the server writes

Amends [ADR-0148](0148-a-sketch-is-a-document.md) (a Skizze holds no image) and the
trust section of [`diagrams.md`](../architecture/diagrams.md). The slice:
[`docs/roadmap/sketches.md`](../roadmap/sketches.md), S6.

## Context and Problem Statement

An architect's day-to-day communication stays on plans and PDFs (feld72, 2026-10-30):
the markup is a cloud and an arrow on page 12 of the Einreichplan, not a fresh
drawing. Research r2 ranked tracing over a page the most useful sketch slice. So a
Skizze needs the page under its strokes: in the editor, in its filed SVG, in its PDF.

Three things stood against it. The SVG validator refuses every `<image>`, `<use>`,
`<symbol>` and `data:` reference, because a filed SVG is served back to browsers.
@react-pdf fetches any image `src` that is not data or a Buffer, which on the server is
SSRF (spike r3). And a page in a Skizze's file is visible to whoever may open the
Skizze, who may be someone the base document is kept from.

## Decision Drivers

* The validator's refusals stay true for every client-sent byte: no picture a client
  sends is ever parsed as a picture.
* The filed SVG and PDF are self-contained: the Files preview is a cross-origin `<img>`,
  downloads and an Einreichung have no session, so a reference would show a hole.
* Markup stays bound to the Fassung it was drawn on; moving it is a person's step
  (r2: Bluebeam's and PlanRadar's lesson).
* A sketch claims no dimension (ADR-0146). No measuring on an underlay: Bluebeam itself
  measures only on a calibrated page, and calibration is the PDF viewer's, not the sketch's.

## Considered Options

1. **Teach the validator an image rule**: `<image>` with a `data:image/png|jpeg` href,
   magic bytes checked, and flatten Excalidraw's `<symbol>`/`<use>` into it, or allow the
   minimal `<use href="#…">`.
2. **A reference in the stored SVG** (`doc:<id>#v=…&p=…`), resolved when shown.
3. **The server writes the page into one fixed slot after the validator**, and every
   reader lifts exactly that slot out before validating the rest.

## Decision Outcome

Chosen option 3.

* **The scene holds a reference.** One locked `image` element per Skizze, at the bottom
  of the z-order, `customData.underlay = { documentId, versionId, page, dpi }`, `fileId`
  derived from the tuple, no `files` (`bff/diagrams/sketch-underlay.ts`). The stored scene,
  the live wire and Piloti's edit admit it through that one file; any other image, an
  unlocked, cropped, turned or flipped one, or a second one is refused. The fence a model
  writes has no `image` type, so Piloti cannot start an underlay in this slice; a person
  starts one from a PDF page („Skizze auf dieser Seite beginnen“ in the review's page menu; „Auf Seite zeichnen“ in the toolbar until 2026-10-31), an outside agent through
  `document-sketch-from-page`.
* **The raster is the server's.** `GET …/versions/{v}/pages/{n}/raster` draws the page in
  the backend (pypdfium, a 16-colour palette PNG, long side ≤ 4096 px), cached per
  (Fassung, page, dpi) beside the Fassung and swept with it; access is reading that
  document (restricted folders, the hold, the download log). The editor loads it with
  `addFiles`.
* **The slot.** The worker draws the underlay over a one-pixel stand-in so Excalidraw
  places it, then takes the stand-in out; the vector picture passes the validator
  unchanged; the save writes `<image data-underlay="" x y width height
  preserveAspectRatio="none" href="data:image/png;base64,…"/>` as the root's first child
  (`sketch-underlay-svg.ts`). Readers (Freigabe's PDF redraw) lift that exact form out
  first. An `<image>` anywhere else is still `unsupported-element`. The PDF gets the PNG
  as a Buffer through `<Image src>`, never a URL.
* **Its own budget.** The vector picture keeps `MAX_DIAGRAM_SVG_BYTES` (1 MiB); the slot
  adds at most 4 MiB of PNG. Measured on an A3 sheet at 150 dpi: a 328 KB PNG, a 475 KB
  filed SVG for a 41-element sketch, a 346 KB PDF drawn in 141 ms; the render itself
  12 ms.

Option 1 rejected because its trust surface is the validator's: every rule it learns is a
spelling a client may try, and the PNG would still be the client's unless the server
compared it to its own, at which point the server may as well write it. Option 2 rejected
because the files leave the product (the Files preview is cross-origin, an Einreichung has
no session) and react-pdf would need a resolver before it, one more place a URL can reach
a fetch.

### Consequences

* Good, because no validator rule changed: client bytes are refused exactly as before.
* Good, because the filed SVG and PDF show the page anywhere, without a session.
* Good, because the page is bound to its Fassung: „liegt auf Fassung 3, aktuell 4“ and an
  explicit „Auf neue Fassung übertragen“, matched by page label, else by number, saved as
  the Skizze's next Fassung; pins and links stay on their elements.
* **The access rule: refuse, never file blank.** A Skizze never shows its underlay to a
  reader who cannot open the base. Live, the raster route reads with the reader's rights:
  a reader without the base sees the strokes on a blank sheet. Filed, the Skizze lies in
  the base's project, and when the base's folder is one some member may not read, in that
  same folder; a save or a move that would break it is refused by name (`underlay_wider`,
  `underlay_other_project`, `underlay_unavailable`). We refuse rather than file without
  the page, because a Skizze drawn on a page means that page: a blank filed picture
  would say something else. A Skizze started on a restricted page is filed without the
  page and moved beside it; its first save there files the page.
* **Only screened bytes** (ADR-0086). A Skizze is machine-filed and never held, so a page
  traced from bytes no passing verdict judged would reach every member through it. The
  raster, starting, saving and moving refuse such a page with `underlay_held` (the
  uploader and the reviewers hear why; anyone else gets a 404). A Freigabe's redraw draws
  the page only while the slot's PNG is the server's raster of screened bytes the scene
  names, else a blank sheet. The slot carries the PNG's SHA-256 (`data-sha256`), which a
  lift checks.
* **Every Fassung's page counts** (migration 0193, `sketch_underlay_bases`). Every document
  a Skizze was ever traced over is recorded and never cleared; a move of the Skizze, of the
  PDF beside it, or of the base asks those rows, not the current scene alone. A base moved
  into a folder narrower than its Skizzen is refused, `traced_sketches_wider` with their
  names (those the mover may open), and the Files pane offers to move them along
  (`withTracedSketches`): the base moves, then each Skizze with every check, and a Skizze
  that will not follow takes the base back. Downloading a Skizze's SVG or PDF logs its
  bases too.
* **Who drew it.** A Skizze a person starts is filed under a `person-sketch-` reference:
  `AIGenerated=false` and „Von einer Person auf einer Dokumentseite gezeichnet“, until an
  agent's edit is filed on it, from when its bytes carry the AI marking and
  „… von Piloti weitergeführt — KI-unterstützt“, kept by every later save. The row stays
  machine-filed, so Freigabe and screening treat it as the sketch it is.
* **Bounded rendering.** Refusals are remembered for five minutes per (organization,
  Fassung, page, dpi), concurrent misses share one render, the raster route has its own
  rate limit (`page-raster`), and the backend checks `Content-Length` first, caps a raster
  at 4096 × 2900 px, runs two renders at once (503 past that) and answers 504 past 25 s.
* **Page matching.** A label is followed only when it names one page; two pages with it
  are the person's choice (`label_ambiguous`); a label gone falls back to the page number
  and the dialog says so; the page count comes apart from the 2000 labels.
* Bad, because tightening a folder's access list (`setFolderAccess`, a folder moved under a
  restricted parent) asks nothing of the Skizzen traced over its documents: their filed
  pictures keep the page as wide as they lie until someone moves them (open, loudly; the
  0193 register makes the check a query).
* Bad, because pdfium cannot be stopped in-process: a render past its time keeps one of the
  two slots until it returns. A killable subprocess is open.
* Bad, because Skizze bytes filed before a base was held keep the page on their presigned
  URLs until the next save or Freigabe redraws them (open).
* Neutral, because the edit receipt (S4) draws the change without the page.
* The doctrine holds: every export says „nicht maßstäblich“; there is no measuring tool on
  an underlay. If the base page is calibrated in the PDF viewer, the link to offer is
  „measure on the base document“, never on the sketch (open).

### Confirmation

`bff/diagrams/sketch-underlay.spec.ts` refuses a crafted scene with an external image, an
SVG image or a non-underlay image at every door (stored scene, live wire, fence, edit, SVG
validator, slot reader); `sketch-underlay-render.spec.ts` files a page through the real
worker and PDF renderer; `sketch-underlay-access.spec.ts` holds the access rule;
`documents/page-raster.spec.ts` the raster's access, cache, refusals and checks;
`sketch-underlay-register.integration.spec.ts` the register under RLS;
`documents/move-to-folder.spec.ts` and `sketch-underlay-service.spec.ts` the moves;
`app/api/documents/[id]/sketch/route.spec.ts` a person-started Skizze's markings;
`apps/agent-host/tests/test_page_raster_route.py` the backend's bounds.

## More Information

Revisit if the PDF viewer's calibration lands (offer „measure on the base document“), when
a BIM view becomes an underlay (its PNG is a capture, stored once, with the BCF viewpoint:
`model-collaboration.md` F5), or if a second image kind ever needs the validator.
