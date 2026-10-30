---
name: excalidraw-sketch
description: >
  Draw a sketch as an excalidraw fence: rooms by adjacency, a site sketch, a
  wireframe, a timeline, a comparison board, callouts over shapes; elements
  that link to a document page, a model element or an Anmerkung. Also how to
  read a filed Skizze and change it with document-sketch-edit. Read before
  writing or changing one.
metadata:
  grid-agents: researcher
  grid-title: Skizze zeichnen
---

# A sketch the reader can rework

An ```` ```excalidraw ```` fence in `answer` is drawn in the chat as a hand-drawn
sketch, and the person can open it in Excalidraw, change it and file it into the
project. Write one when the person asks for a Skizze or for Excalidraw, or when
the picture is spatial or free-form: rooms arranged by how they connect, a site
with its street and access, the idea of a section, the layout of a document, a
timeline, a mind map, two options side by side, notes pointing at parts of a
shape. A flow that forks, a hand-over sequence or a Gliederung stays a mermaid
fence: its layout is computed, and a sketch's is yours.

## The rule that does not bend

A sketch claims no dimension. It is labelled „nicht maßstäblich“ wherever it is
shown and filed. So no lengths, areas, heights, distances or angles in a label,
and no shape sized to mean a size. Where the answer needs a measured value, it
comes from the model view or a document, in prose or a table with its citation,
never from the sketch. A label such as „Wohnen 30 m²“ is counted on the trace as
a sketch claiming a measurement.

## The format

The fence holds JSON: `{"title": "…", "elements": [ … ]}`. The title names the
filed file. Elements are Excalidraw's element skeleton; the browser measures
text, sizes labelled shapes and binds arrows, so write only this:

| type | write | optional |
|---|---|---|
| `rectangle`, `ellipse`, `diamond` | `id`, `x`, `y`, `label: {"text"}` | `width`, `height`, `backgroundColor`, `fillStyle`, `strokeStyle`, `roundness: {"type": 3}` |
| `text` | `x`, `y`, `text` (`\n` for a second line) | `fontSize` |
| `arrow` | `x`, `y`, `points`, `start: {"id"}`, `end: {"id"}` | `label: {"text"}`, `endArrowhead`, `startArrowhead` (`null` for none) |
| `line` | `x`, `y`, `points` (`[[0,0],[dx,dy],…]`, offsets from `x`, `y`) | `strokeStyle`, `roughness` (0 to 2) |
| `frame` | `children` (ids), `name` | |

Any element may also carry `customData`, a link into the workspace (below).
Every other field outside this table is dropped. No `image`, `embeddable`, `iframe`
or `freedraw`: a sketch with one is refused and the reader gets no picture. At most
150 elements and 32 KB; every `id` unique; every `start`, `end` and `children`
id one the scene holds.

## Drawing it well

- Lay it on a grid of 40. Labelled shapes at least 160 × 80, gaps of 60 to
  100 between them, the whole scene inside about 1000 × 700, so it reads at
  the chat's width without zooming.
- Label the shape, do not stack a `text` on it. Free `text` is for a title
  above the scene (`fontSize` 24) and for notes beside it (16). Keep labels
  to three words; a sentence goes in the answer.
- An arrow starts at the edge of the shape it leaves: `x`, `y` on that edge,
  `points` `[[0,0],[dx,dy]]` to the edge of the shape it reaches, both ends
  bound by `id`. A callout is a `text` and an arrow bound only at its `end`.
- Colour carries meaning or nothing: one pastel `backgroundColor` per group
  (`#a5d8ff`, `#b2f2bb`, `#ffd8a8`, `#d0bfff`, `#fff3bf`), `fillStyle`
  `hachure` for the hand-drawn fill, `solid` for a calm one. Dashed
  (`strokeStyle: "dashed"`) for what is proposed or uncertain.
- Order is z-order: zones and frames first, then shapes, then arrows, then
  notes.

## Linking an element

An element can point at what it means: `customData` holds ids, never a title.

| points at | `customData` |
|---|---|
| a page of a document | `{"documentId": "…", "page": 12}` (`page` optional) |
| an element of an IFC model, a Raum, a Unterzug | `{"documentId": "<the model's document>", "ifcGlobalId": "<22 characters>"}` |
| an Anmerkung | `{"documentId": "<its document>", "annotationId": "…"}` |

- A bubble of a Raumprogramm links to its Raum by the GlobalId the model query
  returned (ifc_query, `IfcSpace` by name). Never invent or shorten a
  GlobalId; without one from the model, leave the bubble unlinked.
- An arrow or a callout links to the document and page a search result gave
  („Detail 4, Polierplan S. 12“): the id from workspace-search, the page from
  its passage.
- A defect is an Anmerkung of kind defect: link to it, do not draw a second one.
- A link is never a measurement. It says which thing is meant; the sketch still
  claims no dimension, and a value from the linked element goes in the answer
  with its source.

The reader sees a mark on the element and opens the target in the app; what
they may not open reads as unavailable, with no name.

## Shapes that recur

- **Rooms by adjacency (Raumprogramm):** an `ellipse` per room, rooms that must
  touch drawn close and joined by a solid `line`, a visual or acoustic link
  dashed, groups (Tag, Nacht, Service) in one colour each. Position says
  „near“, never „how big“.
- **Site sketch:** the plot as a closed `line` (`roughness` 2), the street a
  `text` beside its edge, access an `arrow`, the north arrow an `arrow` with a
  `text` „N“, the building a `rectangle` placed, not sized.
- **Section idea:** floors as `line`s, spaces as labelled `rectangle`s, light
  or air as dashed arrows. Storeys stacked, never a height on them.
- **Document wireframe:** a page `rectangle`, blocks inside it labelled with
  what goes there (Kopf, Lageskizze, Legende, Unterschrift).
- **Timeline:** one long `line`, `diamond`s on it for milestones, a `text`
  under each. Dates only as a document states them, with that citation in
  the answer.
- **Comparison board:** one `frame` or `rectangle` column per option, the
  same rows in the same order in each, the recommended one in green.

## Example

```excalidraw
{"title": "Wohnung, Zonen", "elements": [
 {"type": "text", "x": 0, "y": -60, "text": "Zonen der Wohnung", "fontSize": 24},
 {"type": "ellipse", "id": "wohnen", "x": 0, "y": 0, "width": 200, "height": 110, "backgroundColor": "#b2f2bb", "fillStyle": "hachure", "label": {"text": "Wohnen"}},
 {"type": "ellipse", "id": "kochen", "x": 300, "y": 0, "width": 180, "height": 100, "backgroundColor": "#b2f2bb", "fillStyle": "hachure", "label": {"text": "Kochen / Essen"}},
 {"type": "ellipse", "id": "schlafen", "x": 0, "y": 220, "width": 180, "height": 100, "backgroundColor": "#a5d8ff", "fillStyle": "hachure", "label": {"text": "Schlafen"}},
 {"type": "arrow", "x": 200, "y": 55, "points": [[0, 0], [100, 0]], "start": {"id": "wohnen"}, "end": {"id": "kochen"}, "startArrowhead": null, "endArrowhead": null, "label": {"text": "offen"}},
 {"type": "arrow", "x": 90, "y": 110, "points": [[0, 0], [0, 110]], "start": {"id": "wohnen"}, "end": {"id": "schlafen"}, "strokeStyle": "dashed", "startArrowhead": null, "endArrowhead": null},
 {"type": "text", "x": 520, "y": 30, "text": "Morgensonne\nzum Essplatz", "fontSize": 16}
]}
```

One sketch per answer, and a sentence before it saying what it shows.

## A filed Skizze: read it, change it

A sketch filed into the project is a document. Find it with workspace-search,
then read it with document-sketch-get and `scene: "omit"`: the `outline` lists
`shapes` (label, `box` {x, y, w, h}), `texts`, `connections` (from → to, or
`points` where an end is free) and `frames` with their children, each with its
`id`, and the `versionId`. Answer from the outline and name things by their
label, never by id. `ids` reads a few elements whole when you need their style.

**Drawn on a page.** When the outline has an `underlay`, the sketch is traced
over one page of a PDF: `ref.documentId`, its version `ref.versionId`, page
`ref.page`, locked underneath at `box`. That page is what the strokes are
drawn on: name the sketch by it, the document and its page. To say what lies
under a stroke, read the page itself with the
document tools you use for any document (`look` on that document and page,
its passages from a search), and cite it like any page. The underlay is not
to scale here either: never read a length, area or distance off the page or
off the strokes over it, never add one, and never size a new shape to the
drawing's scale. You cannot start an underlay, and an edit that moves,
changes, removes or binds to it is refused (`underlay-locked`): draw around
it. When the read says the base has a newer version, tell the person; moving
the sketch onto it (document-sketch-underlay-move) is their step, never yours
unasked.

To change it, call document-sketch-edit with `baseVersionId` and `ops`. The
person sees the change drawn and decides; nothing changes before. Each op has
an `intent`, one short sentence in the person's language: the card lists them
as the steps. Say where in the words an architect uses, by the room or element
it relates to: „Abstellraum rechts neben dem Flur anlegen“, „Bad unter die
Küche schieben“, „Küche und Essen oben bündig ausrichten“. Never pixels,
coordinates or offsets („40 px nach rechts“, „x = 320“): those are the
server's numbers, not the person's plan.

- `add` takes one element as in the fence table, with a new `id`; `start`,
  `end` and `children` may name elements already drawn.
- `update` with `set`: `label` (or a frame's name), `text` (a free text),
  colours, `strokeStyle`, `x`, `y`, `width`, `height`, and `customData` to
  link the element (the table above; it replaces the link, `null` removes it).
  The outline's `links` and the read's `links` list what is linked, each
  `available` with a `title` or `unavailable`.
- `remove` takes the element's label and every arrow bound to it along; a
  frame lets its children go.
- `rebind` moves an arrow's `start` or `end` to another element.
- Place by reference, not by arithmetic: `place` (`id` beside `referenceId`,
  `side` above, below, left or right, `offset`, `align` start, center or end),
  `align` (`ids` to an `edge`), `distribute` and `stack` (`ids` on an `axis`,
  `stack` with a `gap`). Add a shape with any `x`, `y`, then `place` it.

Arrows bound to what moved are routed again, and a box grows to fit its label.
The answer brings layout warnings (overlap, a label too long, outside its
frame, an arrow bound to nothing): fix one with a new call when it matters. A
wrong op is refused with its number; read the sketch again and redo it. When
the change would need a dimension („schreib die Flächen dazu“), send no ops and
a `note` saying why: a sketch claims none, and nothing is proposed.
