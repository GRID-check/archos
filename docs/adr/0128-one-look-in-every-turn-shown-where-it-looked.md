---
status: proposed
date: 2026-10-21
decision-makers: Grid engineering
consulted: product owner; visual audit and research reports (October 2026)
informed: everyone working on the agent's tools, the cards, the Herleitung and the review canvas
---

# One look in every turn: Piloti looks at a region of a page and the reader sees where

## Context and Problem Statement

On the review canvas a person draws a box, asks, and Piloti renders exactly
that box server-side, reads it and answers in context. The product owner calls
it the best thing Piloti does. Everywhere else Piloti rarely looks on its own,
and in the chat a reader never sees that it looked at all. Measured in the code
on 2026-10-21:

- **One capability, two tools.** `canvas__look(page, region, document)`
  (`tools/canvas/register.py`) and `view_knowledge_image(file_name,
  page_number, collection, image_index, region)` (`knowledge_layer/view_image.py`)
  are the same function, `view_image`, with the same scope check, budget and
  vision gate. Both are bound to the chat agent
  (`configs/config_oib_openrouter.yml`, `shallow_research_agent.tools`). The
  model meets two names and two argument shapes for one act, and the external
  door offers a third name (`knowledge-image-view`).
- **The rule to look lives where the person already pointed.** The only firm
  instruction ("Sieh ihn an, bevor du antwortest") is in the Fokusbereich
  block (`agents/piloti/prompt.py:focus_region_block`), which exists only on a
  turn with a drawn box. `piloti_static.md` carries two general sentences
  ("A drawing or photo is looked at, not read"; "Look before you answer about a
  file"). Nothing says when a look is due in a plain chat turn.
- **A look leaves no trace a reader can see.** On the canvas the box glows
  while Piloti reads (`presence.show_reading`) and the glow is taken down when
  the answer is out. In the chat the look is a `ToolStep` with no row of its
  own: `turn_status` lists `look` among the tools that "get no line", and no
  card shows what was looked at. The reader cannot check a dimension against
  the place it was read from.
- **A cited region is a dead end for the model.** Citations from the visual
  analysis carry a `SourceRegion` box that the UI uses to open the viewer at
  the box (`SourcePreview.tsx`, `region-marks.tsx`), but the grounding text the
  model reads has no line for it, so Piloti cannot look again at the place it
  cites without guessing coordinates.
- **Nothing measures whether looking changes answers.** `focus_region_viewed`
  is the only signal, and only on turns with a box.

The external evidence says the gain is real and policy-shaped. On large
architectural sheets, whole-sheet answering scores 36% and fixed overlapping
crops 49% (LED-Bench). Counting doors and windows is the weakest category of
plan reading (34-39% best case, AECV-bench) while reading printed text is near
0.95, so a look pays off for counts, symbols and small dimension strings, and
much less for a label an exact text hit already holds. Adaptive zoom reaches
always-zoom accuracy with a quarter of the zoom operations (Chain-of-Focus).

The question this record answers: how does looking at a region of a page
become one capability that Piloti uses on its own in every surface, and that
the person always sees?

## Decision Drivers

* The canvas and the chat are mirrors: every capability in one exists in the
  other (headless first, ADR-0122). A look that only the canvas shows is half a
  capability.
* One word per concept for everything an agent reads (root `AGENTS.md`,
  "Industry standard first"), and a capability is reached by one path
  (ADR-0055).
* Every claim shows where it comes from (ADR-0125). A value read off a page is
  a claim whose source is a place on that page, not a passage.
* No customer pixels at rest outside the document they came from: no crop
  files in git, no second store with its own access rules, no images in
  Langfuse (ADR-0089; `revision_compare.traceable` already redacts them).
* Cost: a look is 1.3k-4.8k visual tokens and a model round trip
  (Anthropic vision docs: `ceil(w/28) x ceil(h/28)` tokens, 2576 px long edge on
  the high tier). Looking must be targeted, not habitual.
* Some offices answer with a text-only chat model (`common/model_vision.py`).
  Today such a turn says it cannot see; the office still holds the drawing.

## Considered Options

* **A. Keep both tools; strengthen the prompt.** Leave `canvas__look` and
  `view_knowledge_image` as they are, move the Fokusbereich rule into
  `piloti_static.md`, add a card.
* **B. Keep `view_knowledge_image` as the one tool.** Delete `canvas__look`;
  the canvas glow moves into `view_knowledge_image`.
* **C. One tool `look`, bound in every context, every look visible.** Move
  `look` out of the canvas group into a tool of its own over the existing
  `view_image` renderer, delete `view_knowledge_image`, give it an optional
  `question` that returns readings, and make every look produce a Herleitung
  step and a `look` card, addressed by its place rather than by stored pixels.
* **D. A composite `inspect_region` tool on top of both.** A new tool that
  glows, renders, asks a vision model and returns structured readings, beside
  the two existing ones.

## Decision Outcome

Chosen option: **C, one tool `look`**, because it is the only option that
leaves one name for one act in every surface (chat, canvas, `piloti-ask`, the
external door), keeps the renderer, scope check and budget that already work,
and gives the reader the same evidence on both surfaces.

### The tool

* **Name.** `look`, the name the canvas member already has, the verb the
  prompt already uses ("looked at, not read") and the word the Herleitung will
  print. `view_knowledge_image` is retired: "knowledge image" names neither a
  page nor a region, and its `collection` argument made the model copy an
  internal id. `zoom` (Anthropic's computer-use action) was the standard name
  considered and rejected: it means changing a viewport, and a look is also a
  whole page. The external operation `knowledge-image-view` becomes
  `document-look`, served by the same backend tool (`common/backend_tools.py`).
* **Where it lives.** `src/aiq_agent/tools/look/`, its own
  `@register_function` and `nat.plugins` entry point, bound to the chat agent,
  deep research and the intake agent. The canvas group keeps its other eight
  members; `canvas__look` goes. The renderer stays
  `knowledge_layer.view_image.view_image`.
* **Arguments.** `document` (file name from the inventory or a hit's
  `Citation:` line, or a document id; empty means the document open on the
  canvas, then the conversation's subject: `tools/canvas/target.py`), `page`,
  `region=[x, y, w, h]` (shares of the page as shown, origin top left, the
  frame of `FocusRegion`, `document_annotations` and the canvas), `image_index`
  (an embedded raster), and `question`. The collection is resolved, never
  asked for. A Basiswissen document resolves through the corpus cache as today.
* **`question` returns readings.** With a `question`, the crop is also sent to
  the office's vision reader (the `ingest_vlm` model group, through
  `common/openrouter.py`) with the question, and the result opens with its
  readings: short lines of what it read (a dimension, a count, a date, a
  label), each with a confidence word. The chat model still receives the image
  when it can see; the readings are a second reader, and the description tells
  the model to say so when it sees something else. Without a `question`, no
  reader call is made.
* **A text-only chat model still looks.** When the turn's model takes no
  images, `look` returns the readings alone (with a default question when none
  was given) instead of the "cannot see" sentence. The card and the Herleitung
  step are the same.
* **Budget.** The per-turn cap stays 6 views. At most 2 of them may be whole
  pages, so a turn cannot spend its looks on overviews and never read a region
  (LED-Bench: whole-sheet answering is the weakest mode). Every result states
  how many looks remain. Each look records its rendered size and estimated
  visual tokens on its span. A reading (the second reader's vision call) is
  booked to the usage ledger under the role `look_reading`, inside the turn's
  budget. A call through the external door (`document-look`) runs with its own
  budget of one look and its own ledger tracker for the person the envelope
  names, so each such call costs one look and its reading is booked; the door's
  calls are bounded by the BFF's budget gate.
* **The glow follows the document, not the surface.** `look` calls
  `presence.show_reading` whenever the document is a workspace document, so a
  colleague who has it open on the canvas sees the box glow while Piloti reads,
  whether the question came from the canvas or the chat.

### What the person sees

* **A Herleitung step per look.** A new wire step kind `look`
  (`common/wire_v2.py`): document, page, the region in words ("oben rechts",
  the words the Fokusbereich block already computes), the question, the first
  reading. Rendered "Angesehen: Grundriss EG.pdf, S. 2, oben rechts" with a
  thumbnail, through i18n. (Since ADR-0131 a look draws the work list's own
  row, „Betrachtet Grundriss EG.pdf, S. 2, oben rechts“, with the region in
  the reader's language.)
* **A `look` card per document per turn.** A system card
  (`SYSTEM_CARD_TYPES`; the model cannot emit it), pushed by the tool after the
  render succeeded, extended by every further look at that document in the
  turn, the way `canvas_activity` is extended. Each item is a page thumbnail
  with the region highlighted (`RegionMarks`, the citation viewer's own
  component) and one line: the question, then the first reading. Clicking an
  item opens the document view at that page with the region glowing. The tool
  result names the card (`[[card:N]]`), so the answer can point at it.
* **`highlight` and `point` reach the chat.** Besides the live box on the
  canvas, a highlight adds a `reference` item to the same card, so a chat
  reader sees what the answer refers to.
* **Addressed by place, not stored as pixels.** A card item records
  document id, Fassung (version id), page, region, frame (`page` or `image`)
  and `image_index`, never image bytes. The UI draws the thumbnail from the
  document's own preview route, so the reader is authorized exactly as for the
  document (`getAccessibleDocument`), and a reader who may not open the
  document sees the item without its image, as a citation chip already
  behaves. The render the model saw is reproducible from the same address,
  because the renderer is deterministic for a given Fassung.
* **Citations become places.** A grounding hit with a `SourceRegion` gets a
  `Region:` line in the grounding text, written in `look`'s own frame
  (`[x, y, w, h]`), so the model can look again at the place it cites by
  copying the line. In the chat, a citation peek whose locus has a region shows
  the same thumbnail molecule as the `look` card.

### When Piloti looks

The policy goes into the always-on prompt (`piloti_static.md`, `<sources>`),
because its trigger is the answer the model is about to write, which no tool
description can see (the tools `AGENTS.md` rule: the prompt keeps only what a
description cannot carry). How to look (overview then drill, the budget, the
frame, when to give a `question`) goes into `look`'s description. The policy,
in short:

* Look before stating a dimension, count, symbol, legend entry or title-block
  (Plankopf) value read from a page whose content is graphic; before citing a
  figure; when a hit is an `Image:` caption or its text came from OCR; when
  comparing Fassungen visually (the same region on both); and always at a box
  a person drew.
* Do not look when an exact text hit already supports a plain label.
* On a large sheet, one whole-page look, then one to three regions.

### Consequences

* Good, because the model meets one name and one frame for one act, and the
  external door, `piloti-ask` and the chat all offer the same `look`.
* Good, because every look is visible twice (the step and the card) on both
  surfaces, and the card is the evidence a reader can check a value against.
* Good, because no new store and no new access rule: the address is the
  document's, and the document's authorization decides who sees the crop.
* Good, because a text-only office model gains sight through the vision reader
  instead of refusing.
* Good, because a citation with a region becomes a place the model can return
  to, which closes gap 5 of the visual audit.
* Bad, because a `question` costs a second vision call (one to three seconds
  and its tokens) on a look that also sends the image to the chat model. The
  answer suite's paired run decides whether readings stay on for vision-capable
  chat models.
* Bad, because the rename touches stored turns: an old step named
  `view_knowledge_image` keeps a read-side alias in `executed-steps.ts`, and the
  previous turn's transcript at deploy time names a tool that is no longer
  bound.
* Bad, because the thumbnail is drawn in the browser from the document. A very
  large sheet costs a pdf.js render per card item; the molecule renders only
  the clip at thumbnail scale, lazily.
* Bad, because a reading is a model's perception, not a measurement. It is
  shown as what Piloti read, never as a measured value, and it grounds no
  normative sentence (ADR-0125's anti-laundering rule applies to it unchanged).
* Neutral, because the 6-view cap is unchanged; only its split is new.
* Good, because (amendment of 2026-10-22) a look at a project or office document
  with a `question` registers a citable place, so the value Piloti reads off a
  drawing has a `[N]` of its own; see ADR-0125's amendment of the same date. The
  result's text block is then a grounding block (`tools/look/place.py`), the
  card keeps the region crops that read something of the documents the answer
  cites (no card for an answer that cites none, an empty or "nothing found"
  reading, or an overview beside a crop of the same document), and the card
  item's reading is the line carrying the measured value before the summary.
* Bad, because a look without a `question` has no reading and so no place: it is
  a Herleitung step and cannot be cited. The description already tells the model
  to give a `question` whenever it will state a value.

### Confirmation

* **Surface parity registry.** `frontends/ui/src/lib/surface-parity/parity.config.ts`
  lists every capability with its canvas and chat rendering (look, point,
  highlight, mark, update, delete, reply, compare, ask about a box) or an
  exemption with a reason, like `exposure.config.ts`. Its spec fails when an op
  of `agentAnnotationRequestSchema` or a member of the canvas function group
  has no entry, or when an entry names a card type or step kind the generated
  schemas do not hold. Python reads the exported `tests/fixtures/surface-parity.json`
  in `tests/aiq_agent/tools/test_surface_parity.py`, which fails when a tool of
  the canvas group or `look` is missing from it.
* **Every look reaches a card and a step.** `tests/aiq_agent/tools/look/test_visibility.py`
  runs `look` through the compiled graph and asserts one `look` step and one
  card item per successful look, and none for a refused one.
* **One name.** `tests/aiq_agent/tools/look/test_one_name.py` fails when a
  config, prompt or description names `view_knowledge_image` or `canvas__look`.
* **No pixels at rest.** The `look` card model has no field that can hold
  image bytes (a `data:` URL fails validation), and a span processor test
  asserts `data:image` never leaves the process in a span attribute.
* **Langfuse.** Scores `looked-before-measurement` and `look-count` in
  `SCORE_DEFINITIONS`, held to `docs/observability/langfuse.md` by
  `test_langfuse_scores.py`; the reader call is an `observed_generation`
  (`look-reading`), held by `test_model_calls_are_traced.py`.
* **Behaviour.** The visual set of the answer suite (`--set visual`): questions
  that need a look, paired runs with looking off and on, the box Piloti chose
  scored by IoU against the box the fixture was drawn with. The policy is
  confirmed only by these numbers; nothing else holds the model to it.

## Pros and Cons of the Options

### A. Keep both tools; strengthen the prompt

* Good, because it is the smallest change.
* Bad, because the model keeps two names and two frames for one act, and the
  Fokusbereich block keeps choosing between them by which group is bound.
* Bad, because a card fed by two tools is two producers of one record.

### B. Keep `view_knowledge_image` as the one tool

* Good, because the external door and `backend_tools` already use it.
* Bad, because the name fits neither a page nor a region, and the `collection`
  argument stays a thing the model copies.
* Bad, because the canvas would lose the name its people and prompts use.

### D. A composite `inspect_region` beside both

* Good, because it adds readings without touching what works.
* Bad, because it makes three tools for one act, the opposite of the driver.
* Bad, because the research report's own design (`inspect_region`) is
  `look` plus `question`; the composition fits as a parameter.

## Consumers

| Agent | What changes |
|---|---|
| Piloti in the chat, on the canvas and through `piloti-ask` | Everything above |
| Deep research | Rebinds `view_knowledge_image` to `look`, gets its own image budget per run (it had none: the per-turn budget was bound only for chat turns), and its pruning of old tool results replaces an old image with a one-line stub instead of cutting base64 as text. Its researcher prompt says when to look; the how stays in the tool description |
| Project intake | Stays without `look` until it has an image budget of its own |

## More Information

* Visual audit and research, 2026-10-21 (session reports `vis-audit.md`,
  `vis-research.md`); the delivery plan, slices V0-V10, is `vis-plan.md` in the
  same set.
* Anthropic vision, image sizing and token cost:
  https://platform.claude.com/docs/en/build-with-claude/vision
* Anthropic coordinates (crop the region of interest, offset by the crop
  origin): https://platform.claude.com/docs/en/build-with-claude/vision-coordinates
* Anthropic computer-use `zoom`: https://platform.claude.com/docs/en/agents-and-tools/tool-use/computer-use-tool
* Gemini Agentic Vision (think, act, observe over crops):
  https://blog.google/innovation-and-ai/technology/developers-tools/agentic-vision-gemini-3-flash/
* LED-Bench, cropping and rereading on engineering drawings: https://arxiv.org/abs/2610.19571
* AECV-bench, counting on building drawings:
  https://www.aecfoundry.com/blog/can-ai-really-read-your-building-plans-aecv-bench-gets-a-major-upgrade
* ViCrop (keep the global view beside the crop): https://arxiv.org/abs/2502.17422;
  Chain-of-Focus (adaptive zoom): https://arxiv.org/abs/2505.15436
* Whether a sentence grounded by a reading gets a provenance class of its own
  (`observed`, ceiling `medium`, never normative) is ADR-0125's to amend; the
  plan proposes it as its own slice.
* Revisit when: the paired run shows readings add no accuracy on vision-capable
  models (then `question` is only the text-only fallback); the 2-overview split
  is the binding limit in more than a tenth of visual turns; or a chat model
  gains native region zoom that makes the tool's crop redundant.
