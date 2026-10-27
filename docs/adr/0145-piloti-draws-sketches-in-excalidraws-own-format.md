---
status: proposed
date: 2026-10-27
decision-makers: Grid engineering; the product owner chose the direction on 2026-10-27
consulted: product owner (tested sketches on dev and found them limited to flowcharts)
informed: everyone working in this repo
---

# Piloti draws sketches in Excalidraw's own format

Amends [ADR-0141](0141-a-person-reworks-piloti-drawing-as-an-excalidraw-sketch.md):
its option 2, a model-emitted Excalidraw scene, is taken after all, and its
"the model is unchanged" no longer holds.

## Context and Problem Statement

Since ADR-0141 a person can rework a drawing of Piloti's in Excalidraw, but
Piloti itself only writes mermaid, and only a flow or a Gliederung opens as a
sketch. The product owner asked Piloti on dev for sketches and got refusals or
flowcharts. What an architect sketches is mostly not a graph: rooms arranged by
how they connect (a Raumprogramm as bubbles), a Lageskizze with its street and
access, the idea of a section, the layout of a document, a timeline, two
options side by side, notes pointing at parts of a shape. Mermaid has no
grammar for any of these, and ADR-0141 named the room-relation diagram as the
case that could break its premise.

ADR-0141 rejected a model-written scene for three reasons: the model would
place every box by absolute coordinate, a scene costs about ten times the
tokens of a mermaid fence, and that is exactly the model-written geometry the
diagram doctrine confines (`lib/diagrams/diagram-sources.ts`).

## Decision Drivers

* Piloti should draw what an architect sketches, not only what mermaid parses.
* The doctrine holds: a model-written drawing claims no dimension.
* Industry standard first: Excalidraw's own documented input format, the one
  its MCP app teaches a model, rather than a grammar of ours.
* A reader who never sees a sketch downloads nothing for it (ADR-0141's 2.5 MB).
* Tenant content stays in our infrastructure (ADR-0074).
* Observable in Langfuse (ADR-0089).

## Considered Options

1. **Piloti writes an ```` ```excalidraw ```` fence of Excalidraw's element
   skeleton**, drawn in the chat by the Excalidraw package the editor already
   ships.
2. **Piloti calls Excalidraw's MCP app (`create_view`) and our chat hosts the
   app's iframe**, the way Claude does.
3. **A sketch grammar of our own** (rooms, adjacencies, labels) that we lay out.
4. **Mermaid only** (ADR-0141 as it stands).

## Decision Outcome

Chosen option 1.

**The three reasons of ADR-0141, re-checked on 2026-10-27:**

* *Absolute coordinates.* Excalidraw's element skeleton
  (`ExcalidrawElementSkeleton`, the input of `convertToExcalidrawElements`,
  documented at docs.excalidraw.com, "Creating Elements programmatically",
  and in `@excalidraw/excalidraw` 0.18.1's `data/transform.d.ts`) sizes a
  shape from its `label`, measures text, and binds an arrow to its ends by
  `start`/`end` id. The model places shapes, which for a sketch is the point:
  position is what a room bubble or a site sketch says. What it no longer has
  to get right is every width, text box and arrow end.
* *Tokens.* The skeleton omits ids, versions, seeds and bound-element lists,
  which made a full scene ten times a fence. The example in the skill (seven
  elements) is about 1.1 KB, against ~0.4 KB for a mermaid flow of the same
  size; the fence is capped at 32 KiB and 150 elements.
* *Doctrine.* The doctrine is a rule about subject, and it is kept that way: a
  sketch claims no dimension. The reader sees „Skizze — nicht maßstäblich, ohne
  Maßangabe." under every sketch, a filed sketch carries „Skizze: nicht
  maßstäblich" in its own bytes (`markingSketch`), the skill forbids lengths,
  areas and heights in a label, and a label that reads like one is counted on
  the trace (`dimension_labels`). What has real measurements comes from the
  model view or a document, never from a sketch.

**How it works:**

* **The fence.** JSON, `{"title": …, "elements": [ … ]}` or a bare array, of
  `rectangle`, `ellipse`, `diamond`, `text`, `arrow`, `line` and `frame`
  skeletons. No `image`, `embeddable`, `iframe` or `freedraw`.
* **Checked twice, by one rule set.** `common/sketch_fence.py` checks every
  fence in the dialect pass (`validate_dialect`), so both the settled and the
  terminal answer carry the verdict: size, element count, types, coordinates,
  texts, points, unique ids, bindings to ids the scene holds. A refused fence
  is retagged `excalidraw-refused` and the reader sees its source and one quiet
  line. `lib/diagrams/sketch-fence.ts` applies the same rules in the browser,
  for a fence still streaming and for answers stored before the check, then
  keeps only an allow-list of fields (no `link`, no `customData`) and sets
  every text in Helvetica, the type the filed SVG and PDF can show. Both run
  `lib/diagrams/__fixtures__/sketch-fences.json`.
* **Drawn as it streams.** While the fence is open, each element that has
  arrived whole is drawn (`streamedSketchElements`), as Excalidraw's MCP app
  draws while a model writes; a binding waits for the element it names.
* **Lazy.** `components/sketch-figure.tsx` is a `next/dynamic` chunk of the
  Markdown renderer; it imports Excalidraw only through
  `import('../sketch/sketch-render')`. `sketch-isolation.spec.ts` holds both
  Excalidraw importers to a dynamic edge.
* **Read-only, then editable.** The chat shows the paper SVG Excalidraw
  exported, put through the server's SVG validator in the browser (dark mode is
  Excalidraw's own filter over the same picture). Inside a project,
  „Als Skizze bearbeiten" opens the same skeletons in the ADR-0141 editor, and
  „Im Projekt ablegen" files the scene and its SVG/PDF through the existing
  `diagram-file` operation, as drawn (`edited` absent, keyed by the fence) or
  edited.
* **The skill teaches it, the prompt points at it.** `excalidraw-sketch`
  (`skills/builtin/drawing/`, chat only, `grid-agents: researcher`) carries the
  format, the layout rules and six recurring shapes, read on demand through
  `SkillsMiddleware` (ADR-0135). The static prompt gained one clause in the
  mermaid line, inside its 5,000-token budget. Deep research is not taught it:
  its PDF does not draw a fence.
* **Observable.** One `sketch-drawn` score per fence (`drawn | refused`, the
  refusal as comment, `elements` and `dimension_labels` in metadata) and the
  turn's trace metadata `sketches`. Filing still scores `diagram-filed`.

### Consequences

* Good, because Piloti can draw what an architect sketches, and the person can
  rework and file it in the format they would have drawn it in.
* Good, because the format is Excalidraw's own: no converter of ours, and the
  same JSON Excalidraw's MCP app and its docs teach.
* Good, because nothing leaves our infrastructure: the drawing is part of the
  answer, stored with the conversation.
* Bad, because the first sketch a reader sees downloads Excalidraw (2.46 MB
  gzip), where ADR-0141 charged it only to a click on „bearbeiten".
* Bad, because layout is the model's: a sketch can overlap or crowd where a
  mermaid flow is laid out by dagre. `sketch-drawn` and the reader's vote are
  how we see it; mermaid stays the instruction for flows and hierarchies.
* Bad, because a sketch over the drawing budget of its answer's `kind` is
  logged and kept, like a mermaid fence, not removed.
* Neutral: the answer suite was not run on this change (the OpenRouter account
  had no credits on 2026-10-27); the five sketches the PR shows were written by
  dev Piloti's model with the skill's rules in the question.

### Confirmation

* `tests/aiq_agent/common/test_sketch_fence.py` and
  `lib/diagrams/sketch-fence.spec.ts`: the shared cases, every refusal, the
  allow-list, the streaming reader, the dialect pass leaving a drawn sketch
  byte-identical and retagging a refused one.
* `features/diagrams/sketch/sketch-isolation.spec.ts`: Excalidraw stays behind
  two dynamic imports.
* `app/api/projects/[id]/diagrams/route.spec.ts`: a sketch filed as drawn is
  marked „nicht maßstäblich".
* `tests/aiq_agent/skills/test_builtin.py`: the skill is discovered.
* `/dev/excalidraw-sketch`: the five sketches, a refused one and one streaming.

## Pros and Cons of the Options

### 2. Excalidraw's MCP app in a hosted iframe

* Good, because it is what Claude shows, streaming included.
* Bad, because our chat is not an MCP Apps host: the iframe sandbox and the
  host bridge of the MCP Apps spec would be built first, for one tool.
* Bad, because `create_view` returns a checkpoint id, not the drawing (true at
  `excalidraw/excalidraw-mcp` `157aa23`, 2026-03-24), so nothing could be
  filed into the project.
* Bad, because the hosted server stores every scene (Upstash Redis): a client
  project's sketch at a party no office contracted with, which ADR-0074 rules
  out for content Piloti produces.

ADR-0141 cited [ADR-0065](0065-a2ui-renders-every-card.md) as having rejected
hosting MCP Apps in our chat. It did not: ADR-0065 rejected drawing *our own
cards* as MCP App iframes. Hosting the apps of MCP servers an office connects
is undecided, and it is the next slice this ADR names: an MCP client for an
office's own servers, the MCP Apps host, the office's consent per server. With
it, Excalidraw's app is one connector among many; Piloti's own sketches stay
answer content either way.

### 3. A sketch grammar of our own

* Good, because the layout would be computed.
* Bad, because it is a grammar nobody else speaks, and every new kind of
  sketch is a change to it. Excalidraw's skeleton already covers them.

### 4. Mermaid only

* Bad, because it is what the product owner found limited: no room bubbles,
  no site, no wireframe, no board.
