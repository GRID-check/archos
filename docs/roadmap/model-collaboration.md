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
| Model viewpoint | camera, clipping planes, selected and visible components by IFC GlobalId, snapshot | new |

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

F1 is the foundation; F2 makes it usable; F3 to F5 are independent after it.

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
- **Model Fassungen and GlobalIds.** Revision series come from file names, while a
  Fassung is a `document_versions` row or a confirmed replacement link. Which one does
  a model mark carry along? GlobalIds survive re-export from the same authoring model,
  not re-modelling; does the carry need `compare.ts`'s added/removed/changed sets, or
  is presence enough?
- **Coordinates.** BCF cameras and planes are in the IFC's world frame, metres, Z up.
  The viewer is Y-up and may shift large coordinates for precision. F1 must store
  world coordinates, or exports land the camera kilometres away. A section today is
  one horizontal cut; a vertical one needs the viewer first.
- **Where a snapshot lives.** Object store under the document's tenancy; does it count
  as a download in the download log, and does a restricted folder hide it?
- **PDF marks in BCF.** BCF is 3D-first; a page mark exported as a topic has no
  components and breaks 3D readers. Leave PDF marks to XFDF, or export them only
  as `DocumentReferences`?
