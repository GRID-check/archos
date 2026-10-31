# Model collaboration: one Anmerkung, three anchors, BCF 3.0 at the edge

Status: proposed, 2026-10-29. Handover for its own session. Direction from the
product owner (2026-10-29): adopting BCF 3.0 starts from collaboration, bringing the
Anmerkung to IFC models as a shared foundation, not from a better export.
Reads with [`document-annotations.md`](../architecture/document-annotations.md),
[`sketches.md`](sketches.md), [`ifc-viewer-capabilities.md`](ifc-viewer-capabilities.md)
§6 and [`ifc-review-findings.md`](ifc-review-findings.md).

## The thesis

The shared primitive exists. An Anmerkung already is a BCF topic: a numbered mark
with an Art, a status, a Zuständige, a Frist, a thread, mentions, an inbox row,
Piloti's Vorschläge and carry-over to a new Fassung (migrations 0138, 0150 to 0152).
What differs between a PDF page, a Skizze and a model is only where the mark sits,
its **anchor**:

| Anchor | Where | State |
|---|---|---|
| Page region on a Fassung | `page`, `shape`, `x`, `y`, `w`, `h` on `document_annotations` (0138) | built |
| Elements of a Skizze | `anchor_element_ids`, `anchor_lost_at` (0192), box derived on the server | built (S3) |
| Model viewpoint | camera, clipping planes, selected and visible components by IFC GlobalId, snapshot | built (F1, F2; carry 0194) |

So the session does not build model issues. It adds a third anchor and leaves the
lifecycle alone. One thread, one status set, one Zuständige, one Frist reminder, one
inbox and one Protokoll for all three. A model Anmerkung that grew its own table,
list or vocabulary would be the second product VISION
[principle 8](../../VISION.md#principles) warns about.

BCF stays at the edge: the vocabulary of the export, the import and, maybe later, a
BCF API. Inside, the words are CONTEXT.md's (Anmerkung, Fassung, Zuständige, Frist).

## The scene

Anna has the Tragwerksplaner's model open in the viewer, section at 1 m over EG.
She selects the Unterzug and two Stützen, sets an Anmerkung „Auflager fehlt“, Art
Mangel, Zuständige Max, Frist Freitag. The mark keeps her camera, her cut, the three
GlobalIds and a picture of what she saw. Max gets it in the inbox; „Zur Ansicht“
puts him exactly where Anna stood, with the three elements selected. The Prüfbuch
finds 34 walls without `FireRating` and Piloti proposes one Anmerkung for them;
Anna takes it over. The Fachplaner gets a BCF 3.0 file, opens it in Revit, and the
same topics land on the same elements. Rev. 4 arrives: „3 von 3 Bauteilen in
Fassung 4 vorhanden · übernehmen“. She sketches over the section; the Skizze's base
is that viewpoint.

## What exists in code

- **The record.** `apps/workspace/migrations/0138_document_annotations.sql` (table,
  thread, CHECKs: `…_point_on_page`, `…_region_on_page`, `…_only_piloti_proposes`,
  `…_piloti_needs_a_person`, `…_closing_complete`); `0151` (`carried_from_id`, the
  due index); `0192` (`…_anchor_elements_bounded`, `…_anchor_is_region_on_sheet`,
  `…_anchor_lost_needs_anchor`). `page`, `x`, `y` are `NOT NULL`, so a mark with no
  page is not yet expressible.
- **Placing.** `apps/workspace/bff/annotations/place.ts` (box or elements, never
  both), `sketch-place.ts` (the refusals: a box on a Skizze is 422, elements
  elsewhere are 400), `sketch-anchor.ts`, `sketch-carry.ts` (marks go on with each
  save), `carry.ts` and `carryToCurrent` in `service.ts` (explicit carry for pages).
  Wire schemas: `types.ts`; agent operations in `apps/workspace/bff/agent-api/catalog/`.
- **The model is a document.** `bim_models.document_id` is unique (0034), so an
  Anmerkung's `document_id` can already name the IFC document. Elements are keyed by
  `(model_id, global_id)` with an index; `bff/bim/compare.ts` diffs two revisions by
  GlobalId. Revision series are read from file names (`bff/bim/revision-series.ts`,
  `ui/features/bim/lib/revisions.ts`).
- **BCF today.** `apps/workspace/bff/bim/bcf.ts` writes BCF **2.1**, one topic per
  failing or undecidable Prüfbuch requirement, UUIDv5 topic ids from project and rule
  id, a viewpoint with `Selection` and `Visibility DefaultVisibility="true"` only.
  No camera, no clipping plane, no snapshot, no `AssignedTo`, `DueDate` or `Stage`
  (all listed open in `ifc-review-findings.md`). Route:
  `app/api/projects/[id]/bim/checks/export/route.ts`.
- **The viewer's view.** `ui/features/bim/lib/viewer-camera.ts`:
  `BimViewerCameraState` is a preset (`iso | top | north | south | east | west`), an
  orthographic flag and one horizontal `BimSection { atMetres, flipped }`, encoded in
  the URL by `model-link.ts`. That is a link to a preset, not a camera: orbit, pan
  and zoom are not in it. The renderer's live camera (it has a `target`) lives in
  `components/use-ifc-viewer-canvas-controller.tsx`, which also takes a capture-quality
  `captureScreenshot` (one full frame, no culling or LOD).

## BCF 3.0, mapped

Sources: buildingSMART [BCF-XML 3.0 documentation](https://github.com/buildingSMART/BCF-XML/blob/release_3_0/Documentation/README.md)
and [BCF-API 3.0](https://github.com/buildingSMART/BCF-API/blob/release_3_0/README.md),
both read 2026-10-29.

| BCF 3.0 | Ours |
|---|---|
| Topic `Guid` (lowercase) | `document_annotations.id` (already a uuid) |
| `ServerAssignedId` | `number` („Anmerkung 4“); `Index` is deprecated in 3.0 |
| `Title`, `Description` | `body` (first line as title), `basis` appended |
| `TopicType` (required, from `extensions.xml`) | `kind`: hint, question, defect |
| `TopicStatus` (required, from `extensions.xml`) | `status`: open, resolved, dismissed; `proposed` is not exported (a Vorschlag is not yet the office's record) |
| `Priority` | none; leave empty, do not invent one |
| `AssignedTo` (email recommended) | Zuständige, by their email |
| `DueDate` | `due_on` (Frist) |
| `Stage` | none yet; candidate: the project's Leistungsphase |
| `CreationAuthor/Date`, `ModifiedAuthor/Date` | `created_by/at`, `updated_at` |
| `Comment` (`Guid`, `Date`, `Author`, text, optional `Viewpoint` ref) | a reply in `document_annotation_replies` |
| `Viewpoints` (`.bcfv` plus `Snapshot` png/jpeg, longest side ≤ 1500 px) | the new model viewpoint |
| `Components/Selection`, `Visibility` (`DefaultVisibility`, `Exceptions`, `ViewSetupHints`), `Coloring` | selected and hidden GlobalIds; `IfcGuid` first, `AuthoringToolId` only without one |
| `OrthogonalCamera` (`ViewToWorldScale`) or `PerspectiveCamera` (`FieldOfView`); `CameraViewPoint`, `CameraDirection`, `CameraUpVector`, `AspectRatio` | the captured camera; exactly one |
| `ClippingPlanes` (`Location`, `Direction` toward the hidden half) | the section cut |
| `DocumentReferences` (`DocumentGuid` or `Url`) | the IFC document's Fassung; a Skizze or a PDF page the mark names |
| `RelatedTopics` | `carried_from_id` |

**Carry-forward.** BCF viewpoints "should never be changed once created"; a new
picture is a new viewpoint. That is our doctrine already: a page mark keeps its place
(a position never changes under someone who read it), and a Skizze mark re-derives
its box from element ids. A model mark combines both: its viewpoint is immutable and
stays with the Fassung it was set on; carrying it to a new model Fassung writes a new
viewpoint with the same camera and the GlobalIds still present, explicit, with the
count shown. None left: the mark keeps its last viewpoint and says so, as
`anchor_lost_at` does for a Skizze.

## The foundation slices

Each ships alone. "Makes better" is principle 8's test.

| # | Slice | Makes better | Measured by |
|---|---|---|---|
| F1 | **Viewpoint anchor in the schema, captured in the viewer.** An immutable `annotation_viewpoints` row (camera, clipping planes, selection, visibility exceptions, snapshot as a stored object) shaped as a BCF viewpoint; the mark references it. An explicit anchor discriminator with one CHECK per anchor replaces "which columns are null" (today `page`/`x`/`y` are `NOT NULL`). The viewer reads the renderer's real camera, not the preset, and captures the snapshot. Create stays one route and one catalog operation, `place.ts` gains the third branch, refusals as in `sketch-place.ts` | Anmerkungen, inbox, Frist reminders, mentions, Piloti's wakes, the Protokoll and Offene Punkte: all reach model marks unchanged | model marks per week; share with a snapshot; zero rows failing a CHECK in `db:test:rls` |
| F2 | **Pins in 3D and „Zur Ansicht“.** Pins drawn at the selection's centre (`boundsCentre`); a card button and a deep link restore camera, cut and selection; the agent door returns the same link | the viewer's model links, viewer cards (closes "no camera in a viewer card"), the inbox's way in | „Zur Ansicht“ opens per mark; restored view matches capture (pixel diff in a browser test) |
| F3 | **BCF 3.0 export and import.** One mapping written against 3.0, `extensions.xml` declaring our types and statuses, snapshot from F1. 2.1 stays the default download until the offices' Revit and ArchiCAD BCF managers read 3.0. Import makes Anmerkungen on the model (people as authors where the email resolves, the rest in the thread). Align field names and resources with the BCF API (topics, comments, viewpoints, snapshot, events) so F3b is an adapter, not a rewrite | the Prüfbuch export (gains camera, snapshot, Zuständige, Frist), the Fachplaner round trip | exports per project; import round trip lossless on our own file; topics landing on the right elements in one real tool |
| F4 | **Piloti proposes model Anmerkungen from findings.** A failing or undecidable Prüfbuch requirement becomes one `proposed` mark (author `piloti`, `basis` the citation, selection its elements), idempotent per requirement and revision series like today's UUIDv5 topic ids. `buildComplianceBcf` then exports Anmerkungen; its second topic builder goes | the Prüfbuch, Piloti's Vorschläge, the BCF export (one path, not two) | Vorschläge taken over against dismissed, as a Langfuse score |
| F5 | **Sketch over a model view.** S6's BIM base is an F1 viewpoint: the Skizze names it, elements clicked carry GlobalIds, and its export as a BCF topic uses the browser's composite as snapshot and the Skizze as `DocumentReference` | Skizzen (S5 links, S6 bases), the BIM viewer | Skizzen with a model base; links still resolving after a revision |
| F6 | **Import with triage.** A coordination BCF file becomes ordinary model Anmerkungen (people as authors where the email resolves); Piloti groups duplicates, finds similar earlier marks and proposes a Zuständige, each as a Vorschlag. Not a BCF viewer | the inbox, Piloti's Vorschläge, the Fachplaner round trip (feld72, 2026-10-30) | topics imported per round; Vorschläge from triage taken over against dismissed |

### F1 status: built

Migration `0193_annotation_viewpoints.sql`, the third anchor, the refusals, the two
read routes and the agent operation `annotation-viewpoint-get`, as
[`document-annotations.md`](../architecture/document-annotations.md#a-mark-on-a-3d-model-a-viewpoint)
describes them. The viewer half is `apps/workspace/ui/features/bim/lib/viewpoint.ts`
(`captureViewpoint`, `restoreViewpoint`, render frame to IFC world and back).

### F2 status: built in the viewer, open on the agent door

In the model stage (`apps/workspace/ui/features/bim/`): a dock button sets an
Anmerkung on the view as it is (`hooks/use-model-marks.tsx`). The canvas captures
from the live renderer, not the preset: camera, cut, visibility and selection in IFC
world coordinates from the geometry stream's offsets (`lib/render-frame.ts`), a pin on
the selection's centre or where the middle of the view hits the model, and a snapshot
from one exhaustive frame, downsized to 1500 px JPEG (`lib/snapshot.ts`). All of it
sits in `components/use-viewpoint-bridge.ts` beside the canvas controller, which did
not grow. The composer, list, thread and rows are the review's own (`DraftCard`,
`ThreadCard`, `MarkRowContent`); the panel is `components/model-marks-panel.tsx`. Pins
are the review's `CommentPin`, moved each frame from `projectToScreen` like the
measurement overlay (`lib/viewpoint-pins.ts`), without occlusion. „Zur Ansicht
springen“ and a link with `?mark=<id>` (`lib/model-link.ts`) put back camera, cut,
visibility and selection and say how many elements this model lacks. Preview:
`/dev/model-marks`.

Built since (wave 2): the agent door returns the link with `mark` on every view of a
mark on a model (`viewHref`, `apps/workspace/bff/bim/model-mark-link.ts`, held equal to
`buildModelHref` by its spec), and the `ifc_viewer` card takes an optional `mark` that
opens „Modell öffnen“ at that view. Carry to a new model Fassung is built (below, and
[`document-annotations.md`](../architecture/document-annotations.md#a-mark-on-a-3d-model-a-viewpoint)).

Still open: the pixel diff between capture and restore in a browser (headless
Chromium has no WebGPU, so it is unverified); vertical section planes, which a
restore counts and skips; the card's embedded viewer restoring a mark's view in
place (the link does); the data cards (`IfcDataCards`) naming a mark; a BCF topic
listing every viewpoint of a carried mark (the chain is stored, the export writes
the current one).

### F3 status: export built, import and the button open

`GET /api/documents/{id}/annotations/bcf?scope=all|open` (operation
`document-annotations-bcf-export`) writes a model's Anmerkungen as BCF 3.0, the
mapping above, in `apps/workspace/bff/bim/bcf3-build.ts` (markup, `extensions.xml`,
`bcf.version`) and `bcf3-viewpoint.ts` (`.bcfv`), read behind the Protokoll's gate
by `bcf3-service.ts`. Only marks with a viewpoint go; a Vorschlag nobody took over
never does. `ViewToWorldScale` is the full visible height, as F1 stores it: the
3.0 `visinfo.xsd` says "view's visible vertical size in meters". The specs check
the output against the 3.0 XSDs, vendored unmodified in
`apps/workspace/tests/fixtures/bcf-3.0` (CC BY-ND, buildingSMART), with `xmllint` on
every run; CI installs it and the spec fails there without it. It also reads the
archive back field by field. On 2026-10-30 a file built from `Ifc4_SampleHouse.ifc`
(boxes from IfcOpenShell, framed by F4's core) validated in all eight parts and was
read back by IfcOpenShell's `bcf-client`, an independent reader: version, types,
statuses, assignee, due date, camera, six planes, selection and comments. Loading in
ARCHICAD's BCF manager and BIMcollab Zoom is **unverified**; that file is the test.
The model's marks panel downloads it (open or all). Open: the import (F6),
`DocumentReferences`.
Open: no button in the viewer yet (agents and a direct GET reach it),
`DocumentReferences`. The import is F6's first part (below).

### F4 status: framing core exists, bounding-box source missing

`apps/workspace/bff/annotations/viewpoint-frame.ts` (`frameViewpoint`) is the pure
core: from element boxes in IFC world coordinates (Z-up, metres) it computes the
union, a perspective camera at a fixed azimuth and elevation whose distance fits the
bounding sphere in the field of view with margin, Z as up, an optional six-plane
section box (BCF directions toward the hidden half) and the selection. Geometry comes
only from stored boxes and documented constants, never from a model-written
coordinate. It is not wired: no route, no migration.

It is blocked on a bounding-box source: `bim_elements` stores none, because geometry
lives only in the browser mesher. Recommendation: extract world-space AABBs at ingest
with IfcOpenShell (`ifcopenshell.geom` plus `ifcopenshell.util.shape.get_bbox`) into
a nullable bounds column, with a lazy backfill for existing models. IFC's Z-up metres
is BCF's frame, so no conversion is needed. Pending product-owner approval.

F4 also carries the model counterpart of "ask about a marked area": on a PDF page
the chat shows which region was looked at; on a model mark Piloti receives the
viewpoint's GlobalIds and the IFC data behind them (types, properties, quantities,
storey) through the model-query tools, never the snapshot as something it claims to
read.

### F6 status: import built, triage designed

**Import (built).** `POST /api/documents/{id}/annotations/bcf`, multipart with one
`.bcf` or `.bcfzip` (operation `document-annotations-bcf-import`), the button
„BCF-Datei importieren“ in the model's marks panel with a summary of what became
of the topics. BCF 2.1 and 3.0 through one reader (`apps/workspace/bff/bim/bcf-read.ts`):
2.1's comments and views beside the topic, 3.0's inside it, 2.0's fixed
`viewpoint.bcfv`. Each topic with a viewpoint becomes an ordinary model
Anmerkung; the mapping is the export's, reversed (`bcf-import-map.ts`):

| BCF | Ours | Fallback |
|---|---|---|
| `Title`, `Description` | `body` (a description starting with the title, as ours does, is the body) | cut to 2000 with „…“, said in the thread |
| `TopicType` | `kind`: our Hint, Question, Defect exactly | Issue, Error, Clash and kin → Mangel; Request, Question, RFI → Rückfrage; else Hinweis; the file's word in the thread |
| `TopicStatus` | `status`: our Open, Resolved, Dismissed | Closed, Done → erledigt; Rejected → verworfen; else offen; the file's word in the thread. A closed topic arrives closed by the importer, never as a Vorschlag |
| `AssignedTo` | Zuständige, when the email is someone who may write the document (`requireAssignable`'s rule) | named in the thread |
| `DueDate` | Frist, its calendar day | unreadable: named in the thread |
| `CreationAuthor/Date` | the thread's import note; the importer is `created_by` | |
| `Comment` | a reply by its author where the email may open the document, marked as imported (importer, batch, the comment's own date shown as „im Original vom …“); it arrives at the import's time | the importer's reply, the author's name in the text |
| first `Viewpoint` | `annotation_viewpoints`: either camera, ≤ 6 planes, ≤ 500 selected (those the model has), ≤ 2000 exceptions, colouring, snapshot PNG/JPEG ≤ 1.5 MB | a 2.1 camera has no aspect ratio: 16∶9; past a bound the rest is cut and counted in the thread |

The topic's Guid is kept (`source_topic_guid`, migration 0195, unique per
document; a Guid that is no UUID by a UUIDv5 of it), so the same file twice, or
next round's file that still carries last round's topics, adds nothing; every
mark of one import shares `import_batch_id`, the unit triage works on. The
response lists imported, skipped (`already_imported`, `duplicate_in_file`,
`no_viewpoint`) and failed (`bad_xml`, `no_topic`, `limit`, `error`) topics. The
file is untrusted: the central directory is walked and admitted before anything
is inflated (no two members may share bytes, so one compressed run cannot be
named sixteen times); a member inflates only when a topic names it, through
fflate's streaming `Inflate` counted against its declared size; paths, members
(2,500) and bytes (64 MiB packed, 64 MiB declared in all, 4 MiB an XML part, a
picture past 1.5 MB skipped on its declared size) are bounded (`bcf-archive.ts`); the XML is parsed by `saxes`,
which resolves no DTD and no entity beyond XML's five, and a `<!DOCTYPE>` is
refused outright (`bcf-xml.ts`). A `DueDate` is the day it is in the office's
time zone (one without an offset read as UTC); a camera whose aspect ratio or
field of view strays is clamped and noted. Each Zuständige gets one
inbox row per import, saying how many of their marks remain open and settled only
when none does. The audit event and the counts are written in a
`finally`, so an import cut short still says what it wrote; one request carries
a full document (500 topics, in the order of half a minute), and importing the
same file again resumes where it stopped. Measured by `annotations_imported`
(topics, imported, skipped, failed, assigned per round).

**Topics without a viewpoint** are skipped and reported for now. The next step
frames them on the server from the elements' stored bounding boxes with F4's
`frameViewpoint`, once the improved IFC toolset stores those boxes at ingest; the
topic then imports like any other, and a re-import picks it up, since it was
never remembered.

**Triage (designed, not built).** Piloti reads one import batch and proposes;
a person decides. Each suggestion is a Vorschlag in the existing sense, never a
change made on its own:

1. **Duplicates within the batch.** Two topics about the same thing (a clash
   reported once from each discipline's model). Signal: overlapping selected
   GlobalIds (Jaccard over the selection), the same storey and IFC classes from
   the model-query tools, close text. Proposal: a reply on the later mark,
   „wohl dasselbe wie Anmerkung 12“, with a take-over that dismisses it with a
   link to the kept one. Never merged silently: two Fachplaner's words stay.
2. **Similar earlier marks.** A topic that repeats an open or recently closed
   mark of an earlier round or of the office's own (the same elements by
   GlobalId, which survive re-export, or the same text). Proposal: a reply
   naming the earlier mark and what became of it („in Runde 2 als erledigt
   geschlossen“), so a reopened issue is visible as one.
3. **Proposed Zuständige.** For a mark without one: from the elements' IFC data
   (the discipline of the class and the storey, read through the improved IFC
   toolset's element queries), who answered marks on those elements before, and
   the project's assignments. Proposal: a Rückfrage-style reply with the
   person and the reason; taking it over sets the Zuständige through the
   ordinary PATCH.

Every suggestion is attributed (`basis` names the signal), idempotent per batch
and mark, and scored in Langfuse as taken over against dismissed, the measure F6
names. It builds on the improved IFC toolset: element boxes, classes, storeys
and properties come from IFC data on the server, never from a picture, and no
coordinate is ever written by a model.

F1 is the foundation; F2 makes it usable; F3 to F5 are independent after it.

## Customer input: feld72 Jour fixe, 2026-10-30

Read with judgement, not as a feature list. What it changes:

- **Export first, proven in their tools.** feld72 proposed tying the Anmerkungen to
  BCF and named a BCF export that loads in ARCHICAD or BIMcollab as the simplest
  entry, not a server. F3 came straight after F1 and F2, and its proof is the schema
  check on every file plus a test file for their BCF manager (above).
- **Their vocabulary at the edge, ours inside.** "Lean status and terms on BCF, with
  our extensions": Art maps to `TopicType`, status to `TopicStatus`, and
  `extensions.xml` declares our values. The German UI keeps CONTEXT.md's words; no
  second vocabulary.
- **F6, import with triage (next after export).** A coordination round brings a BCF
  file with the IFC, say 280 topics. Imported topics become ordinary model
  Anmerkungen: one primitive, inbox, Zuständige, Frist, people as authors where the
  email resolves. The value that is ours is Piloti triaging them: grouping
  duplicates, finding similar earlier Anmerkungen, proposing a Zuständige, each a
  Vorschlag a person takes over. They warned against becoming a pure IFC/BCF tool;
  F6 is not a BCF viewer.
- **Direction, not now:** an issue raised by right-click in ARCHICAD that lands here,
  is answered with the agent's help and goes back; a BCF server (BIMcollab Nexus, the
  BCF API). Both sit behind the BCF-API question below.
- **2D and 3D in one issue management** (as BIMx keeps published plans referenced to
  the model) is this document's thesis: one Anmerkung across page, Skizze and
  viewpoint anchors. A Skizze element can already link to an IFC GlobalId (S5,
  `bff/diagrams/sketch-links.ts`); a page Anmerkung carrying related GlobalIds is a
  sensible later step. No automatic mapping between plan and model coordinates.
- **Day-to-day work stays on plans and PDFs for a long time.** F2 and F3 stay lean,
  and 3D work does not crowd out the 2D path.

## Open questions

- **Guests for outside trades (the ÖBA gap).** A Zuständige must be someone who may
  change the document (CONTEXT.md). On site and in coordination the one who answers
  is a trade or a Fachplaner without a seat; BCF's `AssignedTo` is just an email.
  Does a mark's Zuständige become a project party with a guest link, and what may a
  guest see of the model? This decides whether F3's import can assign anyone.
- **BCF API server or file exchange.** Files need no auth and reach every tool. A
  BCF API 3.0 server (`/bcf/3.0/projects/{id}/topics`, `…/viewpoints/{guid}/snapshot`,
  `…/topics/events`, per-topic `authorization`) would be a second door beside MCP
  (ADR-0122), translating to the same routes (ADR-0055) with its own OAuth clients.
  Recommendation: file first; the API when a customer names the tool that will call it.
  feld72 (2026-10-30) agreed: export first. The ARCHICAD round trip and a BCF server
  are the direction this decision would serve.
- **Model Fassungen and GlobalIds. Decided (wave 2, migration 0194).** A model mark
  carries along what a page mark does: the document's published version (the same
  file uploaded again; in place) or a person's confirmed replacement link (across).
  The file-name revision series is a guess for the timeline, not a person's word, so
  no mark follows it. Presence is enough: an element `compare.ts` calls changed is
  still the element the mark asks about, often what it asked for; GlobalIds that a
  re-modelling replaced count as gone, and with none left the mark keeps its last
  viewpoint (`anchor_lost_at`). Explicit, never on upload: „3 von 3 Bauteilen in
  Fassung 4 vorhanden · übernehmen“.
- **Coordinates.** BCF cameras and planes are in the IFC's world frame, metres, Z up.
  The viewer is Y-up and may shift large coordinates for precision. F1 must store
  world coordinates, or exports land the camera kilometres away. A section today is
  one horizontal cut; a vertical one needs the viewer first.
- **Where a snapshot lives.** Object store under the document's tenancy; does it count
  as a download in the download log, and does a restricted folder hide it?
- **PDF marks in BCF.** BCF is 3D-first; a page mark exported as a topic has no
  components and breaks 3D readers. Leave PDF marks to XFDF, or export them only
  as `DocumentReferences`?
