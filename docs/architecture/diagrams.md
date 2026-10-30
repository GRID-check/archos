# Diagrams — drawn in the browser, filed by the BFF

> How Piloti produces a diagram an architect can use in a conversation, and then
> keep as a real file in the project. See also
> [agent-authored documents](agent-authored-documents.md)
> (the pipeline this is the second and third producer of),
> [cards.md](cards.md) (the doctrine this must not break) and
> [ADR-0042](../adr/0042-object-storage-durability-and-quota.md).

## The doctrine, first, because it is the constraint everything else obeys

This repository has fifteen **schematic cards**
(`apps/workspace/ui/features/cards/schematics/`) where the model emits
**parameters only** and the renderer does every piece of geometry. `cards.md`
states what that buys: *"a card cannot show a diagram that disagrees with its
own numbers."* It exists because the card is what gets screenshotted into an
Einreichung.

**A model writing raw mermaid loses that guarantee entirely.** The source IS the
geometry: whatever the model writes is what is drawn, with no arithmetic between
the claim and the picture and therefore nothing to catch a disagreement.

So the rule for this pipeline is a rule about SUBJECT:

| | |
|---|---|
| **Allowed** | Diagrams that make **no dimensional claim** — process flows, sequences, decision trees, state machines, org and relationship maps, Zuständigkeiten, Verfahrensschritte. Nothing on such a diagram is a measurement, so nothing on it can be measurably wrong. |
| **Not allowed, and deliberately not built** | Anything dimensional — a section, a stair, an escape route, a fire compartment, a setback, a daylight angle. Those belong to the schematic renderers, whose geometry is computed. |

The seam between the two is **named and left open**: a schematic card that wants
to become a filed file needs a renderer that serialises the card's own computed
SVG — the same `fileDiagramDocuments` call with the card's geometry instead of a
model's text. That is a new caller, not a new pipeline, and it is not built.

The rule is also visible to the reader where a drawing could be mistaken for a
measured one. Mermaid's own SVG, shown when this product has no view for a
source, carries the line „Schematisch — ohne Maßangabe." / "Schematic — no
dimensions are claimed." (`components/mermaid-diagram.tsx`), and every filed
copy repeats it: the PDF in its provenance block. The product's own views
(flow, map, handoff, schedule, shares) omit the line: they have no geometry to
claim a measurement with.

## Why the browser draws and the server files

Mermaid and excalidraw both **lay out** a graph — they measure text, run a
layout, and only then emit geometry — and measuring text needs a document.
**There is no browser in production**: `playwright-core` is a devDependency, and
putting Chromium into the production image is a deployment decision nobody has
made. So:

```
model writes ```mermaid          browser (has a DOM)                 BFF (owns the write)
        │                                │                                   │
        └── MarkdownRenderer ────────────┤                                   │
                                         │  mermaid.render → SVG string      │
                                         │  flatten the cascade onto attrs   │
                                         │  parse + re-serialise through     │
                                         │  the SERVER'S own validator       │
                                         │        │                          │
                                         │        ├── shown in the answer     │
                                         │        └── POST /api/projects/{id}/diagrams
                                         │                                   │
                                         │                     acceptDiagram (validate,
                                         │                     allow-list, embed source)
                                         │                                   │
                                         │                     fileGeneratedDocument × 2
                                         │                       diagram_svg → .svg
                                         │                       diagram_pdf → .pdf
```

**What is shown and what is filed.** A fence this product has a model for is
drawn by its own view (see *Drawn by this product, parsed by mermaid* below);
only the filed file is mermaid's SVG, drawn on paper when the reader files it
and not before (`renderPaperDiagram`). A fence without a model is drawn as
mermaid's SVG, and in light mode that string is also the file (`fileSvg ===
svg`). In dark mode the file is a second render on paper, from the same source,
renderer, font and `htmlLabels: false`, so mermaid's layout is unchanged and
only the palette differs (`use-rendered-diagram.ts`). "What got filed is not
what I saw" is not a defect a Ziviltechniker can spot before signing, which is
why everything but the palette is held constant.

**A saved Skizze is the exception** (ADR-0149): its picture is drawn by the
server from its scene, below („The server draws the picture“). Filing from the
chat still takes the browser's.

The bytes therefore arrive from an authenticated user's browser. **That is the
same trust posture every upload already has** — and it is stated rather than
assumed, because nothing on the server can assert that the SVG is a faithful
drawing of the source text beside it. What the server *can* assert is that the
file is inert.

## Trust: what the server does with client bytes

**What is trusted, by path.** A filed mermaid diagram and a sketch filed from the
chat: the browser's SVG, held inert by the two rules below; nothing checks it
draws its source. A saved Skizze (`PUT /api/documents/{id}/sketch`): nothing of the
client's picture. The server draws the SVG from the checked scene and files that,
so the picture, the PDF, the outline and the editor come from one scene and cannot
disagree (ADR-0149). The client's scene is still the writer's: checked
(`sketch-scene.ts`), never trusted to be what anyone else drew.

`bff/diagrams/svg.ts` does two things, and neither is redundant:

1. **Refuses, by name.** `<script>`, `<foreignObject>`, `<style>`, `on*`
   handlers, any `href`/`url()` that is not a fragment, DOCTYPE and entity
   declarations (which is what makes XXE and billion-laughs *unrepresentable*
   rather than mitigated), unsupported elements, a missing viewport, anything
   over the size caps, and anything **nested deeper than
   `MAX_DIAGRAM_SVG_DEPTH` (64)**. Named, because a client that gets
   `foreign-object` back can fix its renderer config.

   Depth is a separate budget from size and it has to be, because four walks
   recurse once per level (`parseElement`, `refuseUnsupportedElements`,
   `serializeNode`, `toPdfNode`, plus `@react-pdf/renderer`'s own layout inside
   the last). Measured here: the parser alone died at depth 6000 — ~42 KB, 4% of
   the 1 MiB cap — and the whole route, PDF included, at 1600. A `RangeError` is
   not a `DiagramSvgError`, so before the bound existed a 35 KB document from
   any authenticated session produced an untranslated `Internal server error`
   500 where the module promises a named 400. A real mermaid flowchart nests 11
   deep, so 64 is ~6x what the feature draws and ~1/23 of what it survives.
2. **Re-serialises from an allow-list.** What is stored is written by that
   module out of a table of permitted elements and attributes — never copied
   from the request. (1) is a deny-list and deny-lists are only as complete as
   the day they were written; (2) is what holds when (1) has a gap.

There is no XML library: the Node runtime has no `DOMParser`, and a general
parser's job is to accept while this one's job is to refuse.

`<style>` is refused rather than sanitised — a CSS parser would be a second
place external references can hide, and `@react-pdf/renderer` cannot apply CSS
at any price. The **producer** flattens the cascade onto presentation attributes
before it posts, so a `<style>` arriving at the server means some producer
skipped that step.

**The existing serving posture already closes the classic SVG hole**, and this
work depends on it: `image/svg+xml` is in `PREVIEW_CONTENT_TYPES` (a presigned,
**cross-origin** object-store URL) and deliberately excluded from the
same-origin `/api/documents/{id}/file` stream, whose own comment says an SVG
"must never be served inline same-origin because it can carry script into this
origin". The validation here is defence in depth on top of that, not instead of
it.

## Two rows, and why not one

A diagram is two artifacts and they are not substitutes:

- the **SVG** previews in the Files pane today, is what a reader opens, and
  carries the diagram's own source in its `<metadata>` and its own AI marking in
  its `<title>` and `<desc>`;
- the **PDF** is what gets attached to an Einreichung.

One row cannot be both — a row has one storage key and one content type — and a
sibling object under the first row's prefix is exactly what ADR-0042 forbids:
bytes written outside the document service have no row and are invisible to the
quota ledger. So: two rows, two producers (`diagram_svg`, `diagram_pdf`), one
`fileGeneratedDocument` call each, no second insert path.

That collided with **migration 0064**, which allowed one machine-authored
document per (organization, project, run). **Migration 0065** widens that unique
index and `findDocumentAuthoredByRef` *together* — which is the move 0064's own
header prescribes — so the rule is now one document per (organization, project,
run, **producer**). A producer is a KIND OF DELIVERABLE, and a run owes at most
one of each kind. `deep_research` is unaffected.

The alternative — two synthetic ids, `{ref}:svg` and `{ref}:pdf` — needed no
migration and was rejected: `authored_by_ref` exists so somebody can later ask
what wrote a file and where it came from, and a key that joins back to nothing is
what the schema calls *"an audit trail in appearance only"*.

**A diagram's reference is not a run id, and since migration 0066 nothing claims
it is.** The browser builds it as `{chat answer id}-{FNV-1a of the source}`, so
one answer holding two diagrams files two documents. That value went into a
column called `authored_by_run_id` and rode the `document.generated` audit event
as the id of an `agent_run` target — a structured assertion, in the field the
audit-log export filters on, that a string which is not a job id is one. Anyone
resolving it found nothing, and finding nothing is indistinguishable from a run
nobody has opened yet. The column is now `authored_by_ref` beside
`authored_by_ref_kind`, the kind is derived from the producer rather than passed
in, and the audit target's TYPE is that kind — `answer_artifact` here,
`agent_run` for a research report.

**Where the source lives: inside the SVG's `<metadata>`.** It has to travel WITH
the artifact, because the person who needs to regenerate or hand-edit the drawing
is the person who has the file — possibly a year later, possibly outside this
product. A third `documents` row would be a `.mmd` nobody asked for with its own
quota charge and its own `Zuweisen`; a new column would not survive the download;
the audit record is a compliance trail, not a store you regenerate artefacts
from. A `<metadata>` the client sent as a direct child of the root is discarded
and replaced, so the recorded source is the one the server validated; **one
anywhere deeper is refused** (`unsupported-element`), because that is the
position the module never writes and the one where a second source claim could
hide. It could: a `<g><metadata data-grid-diagram-source="mermaid">` carrying
200 KiB was accepted against a 32 KiB source cap and serialised into the stored
file, since the discard only ever filtered the root's own children.

**Where the marking lives, and why it is not where you would first put it.** A
machine-drawn file that leaves the product has to say so in its own bytes: the
„Von Piloti erstellt" byline is chrome and stops at the download button. The SVG
therefore carries the human sentence in the root's **`<title>`** — which is the
SVG's *accessible name*, so a browser tooltip and a screen reader announce it —
and the machine vocabulary (`AIGenerated=true; AIGenerator=Piloti;
AIHumanReviewed=false`, the same string the PDF puts in `Keywords` and the
`.docx` in typed custom properties) in the root's **`<desc>`**. Both elements are
already in the serialiser's allow-list with no attributes of their own, so the
marking survives the re-serialisation **with the allow-list widened by nothing**
— which is what matters for a file this product serves back to browsers.

Three alternatives were rejected for concrete reasons. **RDF/XMP inside
`<metadata>`** is the textbook answer and is unreachable: every RDF element is
outside `ELEMENT_GEOMETRY`, so the validator *refuses* the submission rather than
stripping the block, and `<metadata>` is reserved for the server-validated
source. A **visible `<text>` footer** cannot be laid out — SVG does not wrap
text, the marking sentence is ~180 characters, and mermaid sizes its `viewBox`
tightly to the drawing — and it would reach the PDF, which renders from the same
tree, and print a second marking under the one already there. A **`data-*`
attribute** on the root is dropped by `keptAttributes`, which is the serialiser
working as designed.

Neither `<title>` nor `<desc>` is paint, so `svg-to-pdf.tsx` maps both to `null`
and the PDF is unaffected; the PDF carries the visible line in its page footer
and the machine vocabulary in its Info dictionary (`Keywords`, with `Creator`
= „Piloti" and `Subject` = the same line). **Neither is a convention any more.**
`GeneratedRendering.marking` is mandatory and branded, so a producer cannot
return bytes without stating how they are marked and cannot state it in a
vocabulary of its own; `fileGeneratedDocument` then verifies the string is
actually in the bytes before it creates the folder, PUTs the object or inserts
the row. That check is what this section exists because of: `diagram_pdf` shipped
with no `Keywords` and `diagram_svg` with no marking at all, and every assertion
available at the time was about the object that described the file.

**Partial filing is recoverable, not rolled back — and it is reported.** The two
calls are not one transaction. The SVG is filed first because it is the half
that carries the source; if the PDF fails, `fileDiagramDocuments` returns
`pdf: null` rather than throwing, the route answers **201** with that null (a
document *was* created and charged to the quota, so any error status would be a
false statement about the project), and the reader is told „Das Bild wurde
abgelegt, das PDF nicht." beside a link to the half that landed and a „PDF
ergänzen" button. Filing again finds the SVG `alreadyFiled` and files only the
PDF: idempotency per (run, producer) is what makes the retry the compensation,
and it is why the button names the PDF rather than the diagram. The cause is
logged for the operator and not shown to the reader, whose remedy is the same
whatever it was.

## Every rule of the existing feature still applies

`authored_by='agent'`, `status='stored'`, **never ingested** (`dispatchDocument`
refuses these rows by reading the row, not by trusting an argument), zero
assignees so the file arrives `Unvergeben`, the „Von Piloti erstellt" provenance
line in the Files pane, one `document.generated` audit event per row, and — since
the marking moved to the filing seam — bytes that state their own authorship in
both files.

## Rendering in an answer

A ```` ```mermaid ```` fence in an answer is drawn instead of printed
(`MarkdownRenderer`'s `code` override → `MermaidDiagram`). The same renderer
draws a fence inside a surface's `Text` leaf; the citation plugins it parses
with there come from `nested-plugins-context.tsx`. Its tables, the other
visual the prose carries, are shaped by `table-shape.ts`
([answer-visuals.md](../design/answer-visuals.md#tables-the-prompt-and-the-renderer-read-the-same-words)).

**A fence the model forgot to tag is drawn too.** `isMermaidFence` reads the
fence's CONTENT as well as its class: a fence whose first line declares a
diagram (`flowchart`, `sequenceDiagram`, `graph`, … — optionally after a
`%%{init}%%` directive) is a diagram whatever its tag says. This is not
politeness toward a sloppy model, it is the common case: asked for a diagram the
model reaches for mermaid and then opens the fence bare, and
`getLanguageFromClassName` answers `bash` for everything it does not recognise —
so the answer promised a drawing and printed a shell listing with a "bash"
header on it. No real listing opens with `flowchart TD`, which is what makes
sniffing the first line safe. Teaching the model to tag its fence is the other
half and belongs in the prompt; it cannot be the only half.

**Nothing outside this renderer may rewrite what is inside a fence.** Quote
verification learned this the hard way: a mermaid label is written
`A["Anwendungsbereich"]`, the ASCII branch of its quoted-span grammar read every
label as a quoted claim, none of them were in a retrieved passage, and the
annotation went in after the closing quote — inside the bracket. The diagram
stopped parsing, and the same flags capped the turn's confidence to "low".
`code_spans` in `citations/markdown_code.py` now excludes fenced and
inline code from that scan. Any future pass over the answer body owes a diagram
the same courtesy.

Three states:

- **streaming** — only the fence still being written is streaming, and it
  holds a skeleton (`DrawingSkeleton`), not its source. Which one that is comes
  from the parsed code block, not from counting backticks (`isOpenFence` in
  `MarkdownRenderer.tsx`): a block that ends on the text's last line without a
  closing fence. That covers `~~~` fences and fences indented in a list item.
  CommonMark runs an unclosed fence to the end of its container, so a
  half-arrived diagram *looks* complete on every token; drawing it would flash
  a parse error per token. Every fence already closed is drawn while the answer
  streams (ADR-0066).
- **failed** — a code block plus one quiet line. The model writes broken mermaid
  regularly and that must cost the reader nothing they did not already have.
  Never a red box, never a throw inside an answer.
- **drawn** — the product's view, or mermaid's SVG with the „Schematisch"
  line when there is no view, and (only where the surface supplied a filing
  target, i.e. inside a project) „Im Projekt ablegen".

The `diagram` CARD that once drew the same sources through the same renderer
was deleted in 2026-09 with the other retired card types
([cards.md](cards.md#retiring-a-card-type)): the fence is the one way in, and a
model that still names the card is told to write a fence instead.

`securityLevel: 'strict'` and `htmlLabels: false` everywhere: the source is
model-authored text, mermaid has a history of label-based XSS, and
`<foreignObject>` is both refused by the server and undrawable in the PDF.
`suppressErrorRendering: true`, because mermaid's own failure path otherwise
appends a "Syntax error in text" graphic to the document and leaves it there,
outside React's tree.

**The drawing is drawn in the reader's theme.** It paints no ground of its
own, so the card shows through, and its ink comes from the product's tokens per
theme (`diagram-palette.ts`, with the theme read off the `.dark` class by
`use-diagram-theme.ts`). The filed bytes are always the paper render
(`fileSvg`): a file is previewed on paper, printed and attached on white. Where
mermaid's SVG is the picture, dark mode adds a second render with the same
source, font and `htmlLabels`, so the layout matches the picture
(`use-rendered-diagram.ts`). Where a view draws the diagram, the paper copy is
the only render, made when the reader files. Every render and parse waits
behind one lock on mermaid's global state (`withMermaid`), and a task that has
not settled after 15 s is failed so the diagrams after it still draw.
A mermaid SVG on screen sits in a `HorizontalScroll`
(`components/ui/horizontal-scroll.tsx`): the hidden edge fades, and the
scroller becomes a named, focusable region only when it overflows, which is
why its `aria-label` is required.

### Two ways in: the fence, and the `diagram` card (history)

The card is gone (`catalog.RETIRED_CARD_TYPES`); this section records why it
existed, because the argument for a catalog entry is the argument for the
prompt's drawing rule.

The fence above is the *rendering* path and it has always worked. What it never
had was a way for the model to learn it existed: a fence has no catalog entry,
so telling the model it may draw meant prompt text competing for attention on
every turn, and for a long time nobody wrote that text at all — `grep -rn
mermaid src/` returned nothing, and the capability shipped unreachable.

The `diagram` **card** was that entry (`cards/models.py`, until it was deleted).
It carries the same mermaid source and renders through the same component, and
it adds the three things a fence cannot have:

- **A catalog entry.** `render_card_index()` puts one line per card type in
  front of the model on every turn, and the trigger table says which content
  takes which card. That is how every other renderer in this product gets
  reached, and the fifteen schematic cards are the proof of what happens without
  it — they sat unused behind a disclaimer until the doctrine named them.
- **Backend validation.** `validate_cards()` checks the payload before it
  reaches a browser: the six supported grammars (`DiagramGrammar`) are a closed set on the card,
  and a model validator reads the source's own declaration line back, so a
  source declaring nothing (the commonest failure, and the one that collapses
  the whole block to a grey code box) is refused with a message the model can
  act on. A fence is unvalidated until mermaid chokes on it in front of the
  reader.
- **A filing decision that survives a reload.** Filing writes two `documents`
  rows, and ADR-0030 says the answer to a card that writes something is
  conversation history and belongs on the `ChatMessage`. `MermaidDiagram` holds
  its filing state in component-local `useState` — the exact defect ADR-0030 was
  written about. That was the argument; the card ended up `presentational`
  after all, because filing turned out idempotent (next section).

The fence stays, and stays supported: it is the fallback for everything the card
refuses, and every diagram already stored in a thread is one.

### Since 2026-09-24: the fence first

The chat prompt now teaches the fence as THE way to draw
(`chat_static.md` <formatting>), and the chat envelope no longer teaches the
`diagram` card (it left the union later that month, `catalog.RETIRED_CARD_TYPES`). Each of the card's three
arguments above was re-checked against the fence:

- **The catalog entry** is the prompt's own list: which shape of answer takes
  which grammar (a Verfahren that forks → `flowchart TD`, who hands what to
  whom → `sequenceDiagram`, the parts of a Regelwerk → `mindmap`, …). The
  model is asked to draw whenever the answer HAS such a shape, not only when a
  Diagramm is requested; that was the reason drawings almost never appeared.
- **Validation** was never what failed. The fence failed in the envelope
  PARSER: `_ANSWER_JSON_FENCE_RE` ended the ```` ```answer_json ```` block at the
  first ```` ``` ```` after it, which is the drawing's own fence inside the
  `answer` string, so the reader got raw JSON. That is fixed
  (`answer_envelope._envelope_blocks`), and a fence that mermaid cannot parse
  degrades to its source with one quiet line, exactly as before.
- **Filing across a reload** is idempotent on (answer, source hash, producer)
  — `use-diagram-filing.ts` — so a fence filed twice finds the same document.

The card is deleted since (`catalog.RETIRED_CARD_TYPES`); deep research draws
with a fence too.

### Drawn by this product, parsed by mermaid

Since the second pass on 2026-09-24 a fence is no longer drawn as mermaid's
SVG. Mermaid is the PARSER: `parse-mermaid.ts` hands the source to
`mermaid.mermaidAPI.getDiagramFromText`, `model.ts` reads the grammar's
database into one of five typed models, and `views/diagram-views.tsx` draws
it in this product's design — the reasoning for each is in
[`docs/design/answer-visuals.md`](../design/answer-visuals.md):

| model | from | drawn with |
|---|---|---|
| flow | `flowchart`, `stateDiagram-v2` | `@xyflow/react` + `@dagrejs/dagre`, card-style nodes, dagre-routed edges |
| map | `mindmap` | the same canvas as a left-to-right tree; an outline below 34rem |
| handoff | `sequenceDiagram` | HTML: a column per party, a row per hand-over; a numbered list below 30rem |
| schedule | `gantt` | HTML: bars on a date axis, milestones as marks; labels above the bars below 30rem |
| shares | `pie` | HTML: horizontal bars with the share written out |

Each view chooses its form by its own width, not by a breakpoint
(`views/diagram-views.tsx`). Flow measures its column (`useWidthRem`, a
`ResizeObserver`) and mounts only the form it shows: the graph from 28rem, a
stepped outline below, so neither pays for the other's dagre pass. Map (34rem),
handoff and schedule (30rem) use a container query; below it map is an
indented outline and handoff a numbered list.

While the parse is in flight (`useDiagramModel` answers `undefined`) the fence
and the card show only the drawing's placeholder, with no „Schematisch" line:
which of the two pictures it becomes is not known yet.

Parsing and rendering share one lock (`withMermaid`): the grammar databases
are module-level singletons, as is the render configuration. A source the
parser refuses, or a grammar without a view, is drawn as mermaid's SVG as
before. Otherwise the SVG is rendered only when the reader files the drawing
(`renderPaperDiagram`, on paper), because filing still files mermaid's SVG and
its PDF.

`model.ts` reads every label of every grammar through `plainLabel`: `<br>` is a
line break, inline formatting is dropped, mermaid's entity placeholders are
decoded, and a label with any other markup makes the reader answer `null`, so
the diagram falls back to mermaid's SVG rather than print a tag. A flowchart's
and a state diagram's direction is the parser's (`getDirection()`), not the
source's first line, which may be frontmatter, an `%%{init}%%` directive or a
comment. A state is labelled by every description it has (`state "…" as L` and
each `L : …`), one line each; a `<<choice>>` is a decision with no label, its
id being a name for the source.

The graph is a named group (`role="group"`), not an image, so a screen reader
reads its node and edge text; an image's content is presentational, and the
outline forms are not mounted or are hidden at the widths the graph is drawn.
An edge label wraps at 160px, and dagre reserves a line of height for every
line it wraps to (`edgeLabelBox` in `views/graph-canvas.tsx`).

A reader also answers `null` for what its view would draw wrong rather than
leave out (the list is in `answer-visuals.md`): a flowchart link that is not a
one-way arrow, a note in a sequence or state diagram (mermaid keeps a sequence
note in `getMessages()` with a `from` and a `to`, so read naively it was a
hand-over), a state `<<fork>>` or `<<join>>`, a bar that splits or merges
concurrent paths which a box would call a step, and a gantt task of hours, which whole-day bars round into a
milestone or a wrong span. An invisible link is dropped, and a state no
transition touches is still drawn.

### Adding a diagram kind

1. **The model.** Add it to the `DiagramModel` union in `model.ts` and a
   reader for its grammar in `modelFromParsed`. `model.ts` is pure: it reads
   mermaid's parsed database and nothing else.
2. **The view.** Add it to `views/diagram-views.tsx` and route it in
   `DiagramView`. Give it a narrow form. A light view switches by container
   query, as the map, hand-over and schedule do; one whose wide form is costly
   to build measures its own width and mounts only the form shown, as the flow
   does (`useWidthRem`, `FLOW_GRAPH_MIN_REM`).
3. **Parsing stays where it is.** `parse-mermaid.ts` calls mermaid inside
   `withMermaid` with `securityLevel: 'strict'`. A reader that returns `null`
   means mermaid's SVG, and then the source.
4. **The model is a pure function of the source.** `use-diagram-model.ts`
   caches it at module level keyed by the source text (`MODEL_CACHE_LIMIT`,
   64). A model that depends on anything else is served stale.
5. **A new grammar**, not only a new view, also needs `DiagramGrammar` in
   `packages/agent/src/agent/cards/models.py`, the grammar list in the prompt
   (`chat_static.md` `<formatting>`), and a browser capture in
   `bff/diagrams/__fixtures__/` that prints through `svg-to-pdf.spec.tsx`
   (next section).

### Which grammars, and how that is decided

`/dev/answer-blocks` draws one fence per grammar through the real renderer;
`?grammars=all` adds the ones left out. A grammar is taught only when it draws
there AND its browser capture in `bff/diagrams/__fixtures__/` prints through
`svg-to-pdf.spec.tsx`:

| grammar | on screen | PDF | taught |
|---|---|---|---|
| `flowchart` (TD) | drawn | prints | yes |
| `sequenceDiagram` | drawn | prints | yes |
| `stateDiagram-v2` | drawn | prints | yes |
| `pie` | drawn | prints | yes |
| `gantt` | drawn | prints | yes — only on dates a project document states |
| `mindmap` | drawn | prints | yes |
| `timeline` | drawn | prints | no — lays out sideways, 1 390 px for five entries |
| `quadrantChart`, `xychart-beta` | drawn | untested | no — invite invented scores and values |
| `classDiagram`, `erDiagram` | drawn | untested | no — model software, not buildings |
| `journey`, `block-beta`, `sankey-beta` | refused | — | no — emit `<foreignObject>` |

`gantt` and `mindmap` needed the PDF converter to resolve `dy`, `em` units and
a `<tspan>` that inherits its line's `y` (`svg-to-pdf.tsx`, `textOrigin` /
`tspanPositions`); before that, gantt ticks printed on the axis and mindmap
labels rode out of their boxes. Flowchart labels were riding high too and
nobody had noticed.

**A drawing is shown at its own width.** Mermaid's `style="max-width: …"` does
not survive the SVG allow-list, so every drawing used to take the column's
width: small ones blew up, wide ones shrank to unreadable. The frame now takes
the viewBox width, capped by the column, and shrinks at most to 0.75 before it
scrolls (`features/diagrams/diagram-size.ts`).

## Measured cost of the dependency

Bundled with esbuild, minified, gzipped, in this repository (`elkjs` is its
published bundle, gzipped):

| package | min | gzip |
|---|---|---|
| mermaid 11.17.0 — first flowchart render (entry + 25 chunks) | 801 KB | **214 KB** |
| mermaid 11.17.0 — every diagram type | 3.45 MB | 947 KB |
| mermaid 11.17.0 — what a dynamic `import()` pulls first | 28.6 KB | 11.1 KB |
| mermaid — added to the main bundle | **0** | **0** |
| `@dagrejs/dagre` 3.1.1, with `@dagrejs/graphlib` | 48.2 KB | 16.8 KB |
| `elkjs` 0.12.0 `elk.bundled.js` (not a dependency; for comparison) | 1.61 MB | 470 KB |
| `@excalidraw/excalidraw` 0.18.1 | 8.40 MB | 2.53 MB |
| `@excalidraw/utils` 0.1.3-test32 (`latest`) | 19.56 MB | 14.03 MB |
| `@excalidraw/utils` 0.1.2 (last non-prerelease) | 1.49 MB | 423 KB |

`@dagrejs/dagre` lays out the flow and map canvases. Graph layout is someone
else's domain, so it is a dependency; ELK does the same job at about 28 times
the gzip size. dagre is imported statically by `views/diagram-views.tsx`, so it
ships with the card components (`AnswerCards` → `DiagramCard`) as well as with
the fence's dynamic import.

`mermaid` is a production dependency, imported dynamically through
`next/dynamic` so a reader whose answer contains no fence downloads none of it.
It has two consumers — the answer and the file.

**Excalidraw does not ship in this vertical.** The editor package costs 11.8× a
mermaid first render to obtain one export function; `@excalidraw/utils`, the
package that exists to be the cheap path, is measurably worse than the editor at
its published `latest`, and that `latest` is `0.1.3-test32` — a prerelease, last
published sixteen months ago, with 32 of 38 published versions carrying a
`-test` suffix. `0.1.2` is cheap and does export `exportToSvg`, but predates
today's scene schema. The kind stays in the vocabulary (`DIAGRAM_SOURCE_KINDS`)
and the server already accepts it, so adding a renderer later is one entry in
`DIAGRAM_RENDERERS`, not a vocabulary migration over stored rows.

**Since ADR-0141 Excalidraw ships as an editor.** The argument above is about
drawing a mermaid source through Excalidraw, and it still holds for mermaid. The new use is a person reworking a drawing
Piloti made. A drawn flow or Gliederung inside a project offers „Als Skizze
bearbeiten" (`features/diagrams/sketch/`):

- `sketchFromModel` turns the parsed `FlowModel`/`MapModel` into Excalidraw
  skeleton elements, laid out by dagre in the view's direction, labels in
  Helvetica. It reads the model, not the source, so the sketch opens in the
  arrangement the person just saw. `@excalidraw/mermaid-to-excalidraw` would
  have parsed again with a second mermaid (it depends on `^11`).
- `sketch-canvas.tsx` is the only importer of `@excalidraw/excalidraw` 0.18.1,
  loaded by `next/dynamic` when the dialog opens (`sketch-isolation.spec.ts`).
  Measured with esbuild: the chat gains 2.4 KB gzip; the click loads 2.46 MB
  gzip.
- Fonts come from `public/excalidraw/` (`scripts/copy-excalidraw-assets.mjs`,
  run with `postinstall`, `dev` and `build` like pdf.js's). Without them
  Excalidraw fetches every font from `esm.sh`.
- Filing: `exportToSvg` (`skipInliningFonts`, always on paper), then
  `fileableSketchSvg` removes `<style>` and `<mask>` and runs the server's own
  parser and serialiser in the browser, then the same `POST` as a fence with
  `sourceKind: 'excalidraw'` and `edited: true`. The route then marks both files
  „Von Piloti entworfen, von einer Person bearbeitet … nicht maßstäblich"
  (`diagrams.markingEdited`). The `<mask>` is Excalidraw's gap in an arrow under
  its label, so in the file a label sits on its line.
- Every filing, sketch or not, scores `diagram-filed` (`as_drawn | edited`) on
  the answer's trace; the browser sends `answerId` for that.

### A filed sketch reopens, and saves as a new Fassung (ADR-0148)

A Skizze is a document whose bytes are the SVG with its scene in `<metadata>`,
so it reopens from Files and every save is the next Fassung of the same
document, never a new pair.

- **Headless first.** `GET /api/documents/{id}/sketch` (`document-sketch-get`)
  answers the stored scene, the `versionId` it was read from and an `outline`
  derived without a model call (`bff/diagrams/sketch-outline.ts`): texts with the
  element each labels, shapes by label, connections from-label → to-label with
  the arrow's label and the bound ids, frames with their children, each with its
  element id and a `box` `{x, y, w, h}` in whole scene pixels (shapes, frames, free
  text, connections), and the `points` of a line not bound at both ends (a plot
  edge, a street), so an agent places things without looking at the picture. The
  outline comes before the scene in the answer; `?scene=omit` leaves the scene out
  and `?ids=a,b` answers only those `elements` whole (at most 200), because a
  150-element sketch's outline is about 25,000 characters and the door shows
  40,000 (`sketch-outline.spec.ts` holds it). 415 for a document without a scene.
  `PUT` (`document-sketch-update`) takes `{ scene, baseVersionId, baseContentHash? }`;
  an `svg` an older editor still sends is dropped unread. `saveTarget` says what a
  save writes: `published`, the next Fassung; `draft`, the open Freigabe
  draft the view was read from (its `versionId` and `contentHash`); or
  `review_open`, nothing (below, „A save during Freigabe“). The read comes from the stored bytes
  (`bff/diagrams/stored-source.ts`), not from the SVG parser, which caps the
  picture at 1 MiB while a stored sketch is picture plus scene.
- **The scene is checked now** (`bff/diagrams/sketch-scene.ts`), on save and on
  read: the fence's element types plus `freedraw`, no `image`, embed or
  `files`, at most 2 000 elements, coordinates within ±1 000 000, text up to
  5 000 characters, and the 512 KiB excalidraw source cap. Filing used to store
  the scene unread. What the fence drops is dropped here too: an element's
  `link`, `customData` outside `SCENE_CUSTOM_DATA_KEYS` (empty for now; a slice
  that ties elements to the workspace names its key there), and `appState`
  outside the four keys Excalidraw's own export writes.
- **A save is versioned against the scene it replaces**
  (`bff/diagrams/sketch-revise.ts`), whoever wrote it: an element whose content
  changed at the version it was read with gets the next version and a fresh
  nonce, one without a version gets one, and an element the save left out is
  kept as a tombstone (`isDeleted`, the next version) for one Fassung. So an
  agent's edit through `document-sketch-update` wins the merge on every open
  canvas, and a delete survives it; an editor's save changes nothing but the
  tombstones. Tombstones that would push the scene over its caps are left out.
- **The server draws the picture** (ADR-0149, `bff/diagrams/sketch-renderer.ts`).
  Excalidraw's own `exportToSvg`, with the editor's settings, runs in a worker
  thread on happy-dom (`sketch-render-worker.ts`, bundled by
  `scripts/build-sketch-renderer.ts` into `dist-sketch-render/`), then the same
  cleaning and validator as the browser (`fileableSketchSvg`, `sketch-svg.ts`).
  The output is the browser's stroke for stroke; a render takes 13 ms for 40
  elements and 40 to 60 ms for 150, the worker about 200 MB while warm. A text the
  save adds or changes is laid out again with the server's metrics
  (`sketch-picture.ts`, `sketch-text-metrics.ts`: the editor's own font files,
  within 0.0005 px of Chromium), so an agent need not guess a label's width. One
  render at a time, 16 queued, a 10 s deadline; a render that fails is a 503 and
  nothing is saved.
- **The marking stays honest.** The SVG goes through `acceptDiagram` as filing
  does, with the two-author line (`diagrams.markingEdited`); the machine half
  stays `AIHumanReviewed=false`, because editing is not a Freigabe.
- **The Fassung** (`bff/diagrams/sketch-version.ts`) is written by
  `insertPublishedVersion`, the repository write every published version goes
  through, with the `baseVersionId` as its expectation: under the per-document
  lock the published pointer must still be that version, or the save is a 409
  with `currentVersionId` (`bff/documents/published-guard.ts`). That write
  carries the pinned marks itself (`bff/documents/published-version.ts`), as
  every publish does, and the save then runs the hook every publish runs
  (`bff/documents/current-version.ts`, `docs/architecture/revisions.md`). It
  runs the upload transition's audit event and event hint, but not its
  `announceNewRevision` for work in progress: a sketch is saved often and each
  save is a Fassung, so announcing each in the inbox would flood it. A save that
  supersedes a Fassung released through Freigabe (`approvedBy` set) does send
  it, once: the office relied on that one. The row stays `stored`, never
  ingested. A sketch filed before it had Fassungen gets its filed bytes recorded
  as Fassung 1 first, so the history starts where Piloti drew it.
- **The PDF is the Skizze's rendition** (`bff/diagrams/sketch-companion.ts`).
  The `diagram_pdf` row filed under the same reference is drawn again from the
  current Fassung and saved as its own next Fassung, but only while that SVG
  Fassung is still current, checked under the PDF's lock (`expected.of`): of
  two overlapping saves the later one's drawing lands last, never the slower
  one's. It is drawn for a save that publishes and for a Freigabe that makes a
  draft current (`sketch-promoted.ts`), never for a save into a draft. It goes
  no wider than the Skizze: moving the Skizze moves the PDF with it
  (`bff/documents/move-to-folder.ts`), and when they sit apart anyway while the
  Skizze's folder restricts reading, nothing is drawn into it (`confined`,
  ADR-0087). It takes no Anmerkungen of its own (400 `sketch_rendition`;
  `canAnnotate` is false): marks belong on the Skizze, where they are pinned
  to elements. When there is no PDF, or a newer save took over, or it is
  confined, the answer says `pdf: null`; when it could not be drawn, also
  `pdfStale: true`, and the editor says the PDF shows an earlier version.
- **A committed Fassung is answered as saved.** Its audit event and hints run
  after the commit; one that fails is logged, not turned into a 500 the editor
  would retry into a second Fassung.
- **The room is told by the server.** After the commit the PUT publishes
  `scene.saved` to `doc:<id>` with the stored scene's hash, stamped as the
  saver and, when the editor sent it (`x-room-peer-id`), with its tab's peer id
  so that tab hears no echo, and `version.published`, which every path that
  makes a Fassung current sends (`bff/documents/current-version.ts`). An
  agent's save, a Freigabe and an upload reach open canvases and previews this
  way.
- **A save during Freigabe.** A save never publishes around an open round
  (`bff/diagrams/sketch-target.ts`). While a draft is open (`draft`, or
  `changes_requested`), a writer's editor opens the draft and a save writes
  into it through the lifecycle's content replacement (`replaceVersionContent`,
  the scene checked and versioned as on any save, compare-and-swap on the
  draft's hash; a save from the published Fassung or an older draft state is
  the 409 `stale_base_version` that merges first). Nothing is published, no
  PDF is drawn, only `scene.saved` tells the open canvases. While a version is
  `in_review` (or `approved` from before ADR-0104 rule 5) a save is a 409
  `review_open`: the editor says „Diese Skizze ist in Prüfung …“, offers
  „Weiterzeichnen“, and the canvas stays live without saving. „Piloti
  überarbeiten lassen“ is not offered for a Skizze, and no revision task opens
  for one (`bff/documents/text-content.ts`): Markdown written into its SVG
  broke the drawing.
- **Only a filed sketch is saved this way** (`diagram_svg`). A person's own
  upload that carries a scene is read, never written: new bytes for it are an
  upload, with an upload's screening.
- **In Files**, a machine-authored SVG whose `GET` answers a scene gets „Als
  Skizze bearbeiten" in the preview's rail (`sketch/sketch-revise-action.tsx`,
  through the documents feature's slot `features/documents/preview-actions.tsx`,
  so documents imports nothing of diagrams). It opens the same lazy editor on
  the stored scene; „Als neue Fassung speichern" saves, and a 409 tells the
  person a newer Fassung exists. The preview asks with `?probe=1`, which
  answers `{ hasScene, canWrite, versionId }` and nothing of the drawing, so
  the download log need not record it; the click reads, logged, and opens the
  latest Fassung (or the open draft). `canWrite` is what the PUT would take:
  write access and a filed `diagram_svg`. When another Fassung becomes current
  (`version.published` from someone else), the preview reads its picture again.
- **Found by what is drawn on it.** Filing and every save that publishes write the
  Skizze's search row from its scene (`sketch-search.ts`, `sketchSearchFacets`):
  title, every text and the frames' names, so a search for „Lift“ finds the sketch
  with a room labelled „Lift“. A sketch is never ingested, so no backend listing
  names it and the shelf's backstop leaves the row alone; a save into a Freigabe
  draft writes nothing (the search shows the current Fassung). A draft that
  becomes current through Freigabe keeps the row of the Fassung before it until the
  next save (open).
- **Compared by its outline.** „Text vergleichen“ on two Fassungen of a Skizze
  diffs their outlines (`bff/diagrams/sketch-outline-text.ts`: one line per
  shape, connection, frame and free text), never the SVG markup.
- **Observable.** Each successful save scores `sketch-revised` (the Fassung
  number), every attempt `sketch-save` (`saved`, `drafted`, `pdf_stale`,
  `conflict`, `review_open`, `refused`, `render_failed`; metadata `carried`, `lost`,
  `render_ms`, `render_elements`, `remeasured`), and every
  Fassung made current that moved a pin `sketch-pins-kept` (the share still on
  an element), on the trace of the turn that drew the sketch.

`DIAGRAM_RENDERERS.excalidraw` stays `null`: reopening hands the stored scene to
the editor, and the preview shows the stored SVG. The one server-side render of a
scene is the save's (above).

The editor offers no AI: `aiEnabled={false}`, and the `ttd` dialog (mermaid to
Excalidraw) is closed when it opens (`sketch/sketch-guards.ts`, ADR-0141's
amendment).

**Since ADR-0146 the model writes Excalidraw too, as a sketch.** Mermaid has no
grammar for what an architect mostly sketches (rooms by adjacency, a site, a
wireframe, a board), so Piloti writes an ```` ```excalidraw ```` fence of
Excalidraw's element skeleton when asked for a Skizze or when the picture is
spatial or free-form; flows and hierarchies stay mermaid. The doctrine holds by
subject: a sketch claims no dimension, and says so.

- **Taught by a skill.** `excalidraw-sketch`
  (`packages/agent/src/agent/skills/builtin/drawing/`) holds the format, the layout rules
  and the recurring shapes, read on demand (ADR-0135); the static prompt only
  points at it.
- **Checked twice.** `common/sketch_fence.py` runs in the dialect pass and
  retags a refused fence `excalidraw-refused` (one quiet line, never the
  JSON; the Word export prints a label, never the scene); `bff/diagrams/sketch-fence.ts` applies the same rules in the browser
  and keeps an allow-list of fields, texts in Helvetica. Both run
  `bff/diagrams/__fixtures__/sketch-fences.json`. Caps: 32 KiB, 150 elements,
  coordinates within ±10 000.
- **Drawn as it streams.** `components/sketch-figure.tsx` draws every element
  that has arrived whole (`streamedSketchElements`), one Excalidraw render at a
  time, through `sketch/sketch-render.ts` (`convertToExcalidrawElements`,
  `exportToSvg` on paper, `fileableSketchSvg`). That module is the second
  importer of `@excalidraw/excalidraw`, reached only by a dynamic import, so
  the first sketch a reader sees loads the 2.46 MB the editor would.
- **The sheet is paper.** A sketch shows on white with Excalidraw's own dark
  filter (`invert(93%) hue-rotate(180deg)`) in dark mode, so the screen, the
  editor and the file are one drawing. Under it: „Skizze — nicht maßstäblich,
  ohne Maßangabe.", and inside a project „Im Projekt ablegen" (as drawn, keyed
  by the fence, marked `diagrams.markingSketch`) and „Als Skizze bearbeiten".
- **Observable.** `sketch-drawn` per fence and trace metadata `answer_dialect.sketches`
  (`docs/observability/langfuse.md`).

### Piloti changes a filed Skizze by operations (S4)

Piloti does not send a whole scene back. It reads the Skizze's outline
(`document-sketch-get`, `scene=omit`) and calls `document-sketch-edit`
(`POST /api/documents/{id}/sketch/edits`) with up to 60 operations, each with an
`intent`, the step as the person reads it:

- `add` (a fence skeleton with a new id, checked by `checkSketchSkeleton`;
  bindings and frame children may name drawn elements), `update` (geometry,
  style, a label or a free text's words, the element's link as `customData`,
  replaced whole or removed with `null`),
  `remove` (takes its label and every arrow bound to it along; a frame lets its
  children go), `rebind` (an arrow's ends);
- the relative `place` (beside a reference, on a side, with an offset and an
  alignment), `align`, `distribute` and `stack`, which the server turns into
  numbers, so a model never does pixel arithmetic from an outline.

`applySketchEdit` (`bff/diagrams/sketch-edit.ts`, pure) builds the next scene:
new elements as `convertToExcalidrawElements` would make them
(`sketch-edit-elements.ts`, fractional indices above the scene's), moves that
carry labels and a frame's members, every arrow bound to what moved, grew or was
rebound routed again edge to edge. It answers the diff (added, removed and
changed ids, a label reported as its box) and layout warnings
(`sketch-edit-lints.ts`: overlap over 5 % of the smaller box, a label its box
cannot hold, outside its frame, an arrow bound to nothing, a label that reads
like a dimension). A wrong operation is a `SketchEditError` naming the op; a
warning leaves the edit valid. The save is the existing one
(`saveSketchDocument`): server render, two-author marking, Freigabe target.

The render closes ADR-0149's open item: when a label is laid out again, the
worker grows its box to hold it (`sketch-label-fit.ts`, Excalidraw's own
arithmetic from `redrawTextBoundingBox`), and a label is laid out again when its
box changes size (`textsToMeasure`).

- **A proposal, checked first.** Piloti's call is an ordinary `operation`
  proposal ([`proposed-changes.md`](proposed-changes.md)). The operation's
  `checkProposal` applies the edit before anything is filed, as the person whose
  turn it is: a wrong op is a 422 to Piloti, never a card nobody can accept; no
  ops and a `note` (the dimension trap) files nothing and Piloti says why; the
  warnings go back to the model beside the proposal.
- **Rebased, not refused.** When someone saved since the edit's
  `baseVersionId`, the edit is applied to the newest Fassung while every id it
  names is still drawn; else 409 `sketch_changed` („Die Skizze hat sich
  geändert“).
- **The receipt.** `SketchEditReceipt` (`ui/features/cards/components/`) draws
  the change from `/sketch/edits/preview` (the server's renderer, on the Fassung
  the edit was made on: new green, removed dashed red, changed blue over its
  dashed grey state before; `sketch-edit-diff.ts`), the legend in words, the
  intents as numbered steps. The preview route is the card's, no operation of the
  door (`agent-reachability.spec.ts`).
- **Undo.** The applied proposal records the Fassung it made
  (`resultItemId`); „Rückgängig“ calls `document-sketch-revert`
  (`POST /api/documents/{id}/sketch/revert`), which saves the Fassung before it as
  the next one while the edit's Fassung is still current and no Freigabe round is
  open, else 409 `moved_on` and the card says why.
- **Observable.** `sketch-edit` (`proposed`, `declined`, `refused`, `accepted`,
  `rebased`, `undone`) on the drawing turn's trace, and `piloti-decision` names
  the `operation`.
- **Measured.** `evals/sketch-edits/` holds the thirteen tasks and the checker;
  the recorded blind answers score Sonnet 13/13 on the outline, 12/13 with the
  picture, Haiku 9/13 under the shipped rules. The product model's run waits for
  an endpoint.
- **Not yet.** In an open editor the proposal is not drawn as a ghost layer
  with its own buttons; the person decides on the card.

### A sketch element links into the workspace (S5)

An element can point at what it means: an arrow at „Detail 4, Polierplan S. 12“,
a Raumprogramm bubble at the model's Raum, a cloud at an Anmerkung. The link is
Excalidraw's own `customData` with the keys of `SKETCH_LINK_KEYS`
(`bff/diagrams/sketch-links.ts`) and no others: `documentId`, then `page` and a
pinned `versionId` for a document, `ifcGlobalId` for an element of the model
that document is, or `annotationId` for an Anmerkung on it. A defect is an
Anmerkung of kind `defect`; an Aufgabe is work handed to Piloti, so there is no
`taskId`. Excalidraw's `link` field stays dropped everywhere.

- **One list, every door.** The fence keeps a valid link and drops every other
  key (`sketch-fence.ts`), `common/sketch_fence.py` counts the same links on the
  trace (`links` on the sketch score), and `__fixtures__/sketch-fences.json`
  holds both to the same `link_keys` and cases. The scene a save stores and the
  live wire keep it through `withoutForeignFields`; `document-sketch-edit`'s
  `set.customData` takes a link or `null`, and its diff compares what a save
  keeps. A wrong value (a GlobalId that is not 22 characters, page 0, a
  document, Fassung or Anmerkung id that is no uuid) drops the link whole: half
  a link points somewhere nobody meant, and a non-uuid id bound to a uuid column
  makes Postgres throw. A key set to `null` reads as absent, and `12.0` is page
  12, in both fences.
- **Ids in the scene, the reader's view on read.** The outline lists `links`
  `{elementId, kind, ref}`. `GET /api/documents/{id}/sketch` resolves them per
  reader (`sketch-link-resolve.ts`): a document through `getAccessibleDocument`
  (shelf, folder visibility, the hold), a pinned Fassung by its row when it
  was published and its bytes are the reader's (`versionBytesReadableBy`; a
  draft in Freigabe or a held upload shows no number), a model element through
  `findElementsOfReadDocument`, an Anmerkung by its row on a document the reader
  may open. Gone or not theirs: `unavailable`, no title and no reason, so a link
  never names a document its reader cannot see. The links are grouped by
  document: one access check per document, one query per kind of target
  (`sketch-link-repository.ts`, no reply threads), four documents at a time, at
  most 60 links per read. Any error resolving a link makes it `unavailable`
  (logged unless it is a refusal), never a failed read. The search row indexes
  no link.
- **In the editor.** A linked element carries a mark at its corner
  (`sketch-links.tsx`); pressed, it opens the target with `router.push`
  (`features/documents/lib/sketch-link-href.ts`: the document's preview at the
  page, the model view at the element, the review at the mark), or says
  „Nicht mehr vorhanden“ in place. A linked Anmerkung colours its mark by its
  status, read with the link and never stored. „Verknüpfen“ on one selected
  element opens the picker (`sketch-link-picker.tsx`): a document and page from
  the workspace search, a model element by name from the project's models, an
  Anmerkung from the search. `sketch_link_opened` (PostHog) counts the opens.
- **Piloti** links through `document-sketch-edit` and writes links in a fence;
  the skill says a GlobalId comes from `ifc_query`, never made up, and a link is
  never a measurement.
- **Not yet.** A pinned Fassung opens the document's current preview at the page
  (the preview has no address for a Fassung); a page past the document's end is
  not refused, because the page count lives only in the search projection; the
  Files preview of a target does not yet say „verlinkt aus Skizze …“; a link a
  co-editor sets live shows as unresolved until the next open.

## Two people on one Skizze

A Skizze is a document (ADR-0148), so its editor joins the room every document
has, `doc:<id>` (ADR-0110 and its amendment of 2026-10-29). What the canvas adds
to the room's vocabulary is in `lib/diagrams/sketch-room-types.ts`:

| Field up | Event down | Who | Lane, budget |
|---|---|---|---|
| `scene` (pointer in scene coordinates, `pointer`/`laser`, button) | `scene.pointer` | anyone who reads | motion, `ROOM_LIMIT`, 80 ms |
| `sceneSelection` (element ids) | `scene.selection` | anyone who reads | motion, `ROOM_LIMIT`, 150 ms |
| `delta` (changed elements, `seq`, optional `full` part) | `scene.delta` | a writer | `sketch-edit`, `SKETCH_EDIT_LIMIT` |
| `hash` (the scene's `hashElementsVersion`) | `scene.hash` | anyone who reads | `ROOM_LIMIT` |
| `want` (send me the whole scene) | `scene.want` | anyone who reads | `sketch-want`, `SKETCH_WANT_LIMIT` (12 a minute) |
| `saved` (a Fassung was written) | `scene.saved` | a writer, and the server after every PUT | `sketch-edit` |

A message spends the budget of every lane it touches, so a `want` riding on a
claim still spends the `want` budget. An element travels only if it is of a
type a saved scene may hold (`SCENE_ELEMENT_TYPES`), and loses `link` and
foreign `customData` on the wire as on the save.

How the canvases converge (`features/diagrams/sketch/sketch-sync.ts`):

- Every Excalidraw element carries a `version` each edit bumps and a random
  `versionNonce`. `reconcileElements` keeps the higher version per element,
  the lower nonce on a tie: Excalidraw's own collaboration merge, commutative
  and idempotent, so no CRDT.
- After an edit the canvas sends the elements whose version passed what the
  server last took from it, tombstones included, at most every 100 ms, one post
  at a time, in parts of at most 400 elements and 64 KB. An element is marked
  sent only when the post answered 2xx; a lost post or a 429 keeps it for the
  retry. A 400 or 413 is not retried: the part is split until the one element
  the server refuses is alone, that one is set aside (the editor says so) and
  the rest travels. A 403 stops the tab's edits. One element over 64 KB on its
  own (a long freehand line) does not travel live and reaches the others with
  the next save.
- An element taken from a peer counts as sent, so the canvas's `onChange`
  after applying it does not send it back; the canvas's own events coming back
  from the room are dropped by `peerId`.
- Repair: a gap in a peer's `seq`, or two hash beacons in a row from one peer
  that differ from this scene (hashed over the elements still drawn), asks for
  the whole scene. A writer answers after 150 to 500 ms unless it hears another
  answer first, and answers one person (by the user id the server stamped) at
  most once every 5 s and six times a minute in all; the asker merges the
  answer and sends back what it holds newer or the answerer lacks. Beacons go out every 5 s while others are here and
  only after a second without drawing.
- The pure modules take Excalidraw's helpers as arguments, so
  `sketch-canvas.tsx` stays the only importer of `@excalidraw/excalidraw` and
  the chat bundle keeps its size (`sketch-isolation.spec.ts`).
  `sketch-sync.spec.ts` imports the real `reconcileElements`,
  `hashElementsVersion` and `restoreElements` and converges two and three
  seeded replicas through drops, reorders and refusals.

The Fassung stays the truth: a save writes one, and a canvas that joins late
or lost the room opens the latest Fassung and asks for what was drawn since. A
delta is a hint towards the same scene, never a record.

- On `saved`, a peer moves its base to the new Fassung only when its scene
  hashes to the saved one. Otherwise it keeps its base, so its own save is a
  409 that merges first, and the editor reads the new Fassung and merges it at
  once (a logged read; the probe carries no scene). A canvas that missed a delta can therefore
  never save over the Fassung without it.
- Merging a newer Fassung (after a 409, or on such a `saved`) deletes on this
  canvas what that Fassung left out, when the base Fassung drew it and this
  canvas has not changed it since, as a tombstone that travels on; an element
  changed here since stays, as an edit beats a delete in Excalidraw's merge.
  The server's tombstones (above) make the same delete explicit for one
  Fassung. An element drawn and deleted between two saves whose tombstone a
  canvas missed is repaired by the hash beacons, not by the merge.
- A save reads its base before it takes the scene, so a merge that lands while
  the picture is drawn makes the save stale rather than lossy.

In the editor (`sketch-dialog.tsx`, `use-sketch-room.ts`):

- One room per tab. The editor opened from the Files preview joins through
  the preview's room (the review's, `useSketchRoom({ room })`), so a person is
  one peer: no avatar of her own on the canvas, no „Anna ist noch hier“ in the
  close guard, one entry in Piloti's `roomSnapshot` (which also lists a person
  in two tabs once), and no pointer motion while she is alone. An editor with
  no room to share (`/dev/sketch-room`) opens its own.
- A reopened Skizze joins the room when the dialog opens. `GET …/sketch`
  answers `canWrite`; a reader's canvas is in view mode, has no save button,
  and still shows everyone draw. The send path checks write access again for
  every edit, so the flag only decides what the editor offers.
- Excalidraw's own collaborator rendering shows the others: pointer, name
  tag, selection outline and the avatar list, in each person's identity
  colour (`sketch-collaborators.ts`). The agent is named with the person it
  acts for.
- Saving is explicit, by any writer, one Fassung per save, no autosave. The
  canvas stays open after a save and sits on the new Fassung; the room hears
  `saved`, and a peer whose canvas shows exactly that scene is told so and is
  clean again. A save refused as stale (409, someone saved first) reads the
  newer Fassung, merges it into the canvas and tries once more; a second
  refusal asks the person to save again.
- Closing with unsaved changes while another person is in the room says that
  they keep the changes; never the person herself, from another tab.
- `/dev/sketch-room` is two people in one room over a `BroadcastChannel`
  (open it twice, `?as=max`, `?role=reader`), with a stand-in for the route
  that answers 409 on a stale base.

## Known limits

- **`journey`, `block-beta` and `sankey-beta` do not draw.** Mermaid emits
  `<foreignObject>` for them regardless of `htmlLabels`, so they are refused
  and degrade to their source. The six taught grammars are verified end to end
  (table above).
- **Typefaces are not preserved in the PDF.** `@react-pdf/renderer` knows the
  standard PDF fonts and nothing else; every `font-family` lands on Helvetica,
  varying only weight and slant. Asking it for mermaid's `"trebuchet ms"` throws
  at render time, so a diagram would otherwise fail to become a PDF over a font.
- **Arrowheads are computed, not referenced.** `@react-pdf/renderer` exports a
  `Marker` component whose renderer cannot resolve an SVG `url(#id)` reference,
  so `svg-to-pdf.tsx` draws the heads itself from each edge's own end tangent. A
  path using a command other than `M`/`L`/`C` gets no head rather than one
  pointing the wrong way.
- **Drop shadows, `<use>`/`<symbol>` icons and CSS are dropped by the producer**,
  because none of them survives into the PDF — and the answer, the stored SVG
  and the PDF have to show the same drawing.
- **The `.docx` export and the research-report PDF do not draw a diagram.**
  The `.docx` carries a label and the mermaid source
  (`lib/answer-export/markdown.ts`); the report PDF prints a placeholder
  (`lib/pdf/markdown-pdf.ts`). Both run on the server, which has no DOM to lay
  a graph out. The fix is for the browser to render the paper SVG
  (`renderPaperDiagram`, the same bytes filing sends) and send it with the
  export request; the report PDF can
  then draw it through `svg-to-pdf.tsx`, and the `.docx` needs an image part.
  Not built yet. Filing from the answer is the path that yields a real drawing.
