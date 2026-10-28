---
name: excalidraw-sketch
description: >
  Draw a sketch as an excalidraw fence: rooms by adjacency, a site sketch, a
  wireframe, a timeline, a comparison board, callouts over shapes. Read before
  writing one.
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

Every field outside this table is dropped. No `image`, `embeddable`, `iframe`
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
