# Piloti's system prompt: value audit, 2026-10

What each part of the old `piloti_static.md` was for, and where it went when the
prompt was cut from 13,780 to 4,975 tokens (characters / 4) on 2026-10-22. The
rendered system prompt, with the envelope schema the models inject, went from
18,266 to 9,224 tokens. Read this before adding a line back.

## The test every line had to pass

1. **Can the agent find it out itself, at the moment it matters** (a tool
   result, a tool description, the turn context, an error)? Then it is cut.
2. **Does code already enforce it** (proposals, confined content, the round
   cap, citation verification, the width cap, the duplicate guard)? Then the
   prose is cut and the rail stays in code.
3. **Would its absence produce a wrong answer nothing catches?** Then it stays,
   once, with its reason, in calm words.

A line that a test pinned because of a field case (a measured regression) was
kept when the case still applies, and the test now pins the new wording.

## The order

Most important first and last, reference in the middle, as the in-window vendor
guidance the brief cites recommends (vendor guides dated 2026-09/10):

| Position | Section | What it holds |
|---|---|---|
| 1 | `<role>` | Identity, the goal of a turn, what the `<turn_context>` message is |
| 2 | `<good_answer>` | What a good answer is for an architect, and who Piloti is not |
| 3 | `<building_law>` | Reference: the chain, editions, ÖNORM, parcel, disagreement |
| 4 | `<voice>` | Language, Sie-Form, number orthography, the craft rules with a field case |
| 5 | `<formatting>` | Markdown, math, Mermaid, the RICH BLOCKS dialect (a renderer contract) |
| 6 | `<rules>` | Standing rules, each with its reason |
| 7 | `<answer_envelope>` | The output contract: schema, kinds, fields, citations, three examples |
| 8 | `<done>` | Definition of done for a turn, last |

## Line by line

Value-test column: the question that decided it (1, 2, 3), or `case` when a
test recorded a field case behind it.

| Old section, line group | Fate | Test | Where it lives now |
|---|---|---|---|
| `<role>` identity, workspace before law, proposing | kept, shorter | 3 | `<role>` |
| `<role>` „leg an", „füg hinzu" examples of a message | cut | 1 | gone: the message itself shows it |
| `<role>` a normative value comes from a document retrieved this turn | kept once | 3 | `<rules>` first line |
| `<role>` not the Entwurfsverfasser, not the Behörde | kept | 3 | `<good_answer>` |
| `<language>` answer in the request's language | kept | 3 | `<voice>` |
| `<language>` two sources labels, contract tokens in Latin script | kept | 3 | `<answer_envelope>` CITATIONS and opening |
| `<formatting>` KaTeX inline and display syntax, four bullets | condensed to one | 3 | `<formatting>` |
| `<formatting>` Mermaid: when to draw, per diagram type | condensed | case | `<formatting>` (the „a diagram printed as a listing" case) |
| `<formatting>` Mermaid syntax details (node shapes, participants) | cut | 1 | gone: the model knows Mermaid; the renderer shows a broken fence |
| `<formatting>` no measurement in a drawing, no box art | kept | case | `<formatting>` |
| STRUCTURE first line answers, headings that state, tables, bold | kept, condensed | 3 | `<formatting>`, ruling rule in KINDS |
| STRUCTURE variants as a `surface` with `Tabs` | cut | 1 | CARDS COMPOSE, rendered from `cards/envelope.py` |
| STRUCTURE `:::actions` for what is still to do | kept | 3 | RICH BLOCKS |
| RICH BLOCKS: every directive, budget, status words | kept, one line each | 3 | `<formatting>`; parity with the renderer stays an obligation |
| `<output_contract>` one fenced `answer_json`, five kinds | kept | 3 | `<answer_envelope>` KINDS |
| direct: no confidence, first name, shelf listing | kept, one line | 3 | KINDS `direct` |
| direct: a search is not wrong here | cut | 1 | gone: „cited only for a retrieved passage" covers it |
| direct: shelf listing uses only that shelf's group | cut | 1 | the inventory block says it (`knowledge/inventory.py`) |
| direct: a plain-words Baurecht question earns structure | kept | case | KINDS `direct` |
| off-topic decline, its example | kept as a rule, example cut | case | `<rules>` last line |
| walkthrough: what it is, sources section, topic/context | kept | 3 | KINDS `walkthrough`, CITATIONS |
| ruling: copyable value, read first, verdict | kept | 3 | KINDS `ruling` |
| work: lists, `proposed` with ref, record not cited | kept, condensed | 3 | KINDS `work`, CITATIONS; list semantics in the schema |
| work: „says nothing is changed until accepted" | cut | 1, 2 | `workspace__call` returns „Proposed", its description says never claim done; the server never runs a write |
| handoff: when, one sentence, no retrieval first; a document is drafted | kept | case | KINDS `handoff` |
| `<stimme>` examples show form, values are placeholders | kept once | 3 | `<rules>` and EXAMPLES heading |
| `<stimme>` repeat nothing the question says | kept | 3 | `<voice>` |
| `<stimme>` uncertainty per part, confidence follows the weaker part | kept | case | `<voice>`, FIELDS `confidence` |
| `<stimme>` normative statement from a passage; not a Bescheid | kept once | 3 | `<rules>`, `<good_answer>` |
| `<stimme>` quotations ≤ 40 words with Fundstelle | kept | 3 | `<voice>`; the server checks quotes (ADR-0067) |
| `<stimme>` Austrian German, Sie-Form, no self-description | kept | 3 | `<voice>` |
| `<stimme>` between rounds, the `conclusion` argument | cut | 1 | the tool descriptions own `conclusion=` |
| `<stimme>` number orthography | kept whole | 3 | `<voice>` |
| `<stimme>` one degree of warmth | kept, one sentence | case | `<voice>` |
| `<stimme>` the form the content has, six forms | condensed | 3 | `<formatting>` opening |
| `<stimme>` layering every three to five lines | cut | 3 fails | gone: headings past three paragraphs suffice |
| `<stimme>` ruling build, order of examination, reservations last | kept | case | KINDS `ruling` |
| `<stimme>` false assumption: correction is the answer | kept | case | `<voice>` |
| `<answer_envelope>` platform renders one document, field order | kept | 3 | `<answer_envelope>` opening (ADR-0066 order) |
| `<answer_envelope>` schema `{{ answer_envelope_schema }}` | kept, exact | 3 | rendered from the models; the `work` item shape now once, not four times |
| `confidence` definition, measurement counts, no chip without it | kept | case | FIELDS |
| `escalate_to_deep` definition | cut here | 1 | the schema line and KINDS `handoff` say it |
| four compartments, one fact | kept, one sentence | 3 | FIELDS last line |
| `summary`, `topic`/`context`, `verdict` rules | kept, condensed | 3 | FIELDS, KINDS |
| `takeaways`: claim not topic, detail repays the click | kept, condensed | case | FIELDS; the long form is in the schema description |
| `callout`: at most one, `[[callout]]` placement | kept | 3 | FIELDS |
| `<domain_brief>` chain of instruments | kept | 3 | `<building_law>` |
| `<dokumentrollen>` roles, Leitfaden, Erläuterung, MA 37, no commentaries | kept, condensed | 3 | `<building_law>` |
| deviation discipline, edition declared binding | kept | 3 | `<building_law>` |
| parcel questions at the Grundstück | kept | 3 | `<building_law>`; which plans exist is the turn's `parcel_note` |
| terms follow the level; ÖNORM honesty; Bestand | kept | 3 | `<building_law>` |
| `<project_grounding>` confirmed / unknown / assumptions | kept | 3 | `<rules>` |
| `<project_grounding>` country and federal_state tokens | kept, one line | 3 | `<building_law>` last line |
| `<project_grounding>` no Gebäudeklasse from memory | kept | 3 | `<rules>` |
| `<examples>` direct reply, off-topic, hand-off, drawing value, organising | cut | 3 fails | rules carry them; three examples remain |
| `<examples>` ruling, overview walkthrough, work | kept | case | EXAMPLES |
| `<conduct>` memory: you have `remember` | cut | 1 | the `remember` tool's own description |
| `<conduct>` office instructions never override the rules | kept | 3 | `<rules>`; also beside the block in the turn context |
| `<working>` where evidence lives (shelves, RIS, web) | cut | 1 | tool descriptions and the inventory |
| `<working>` „Bereits gelesen" explanation | cut | 1 | the block explains itself (`knowledge/already_read.py`) |
| `<working>` what a good answer is | kept | 3 | `<good_answer>` |
| `<working>` file not opened is not described | kept | case | `<rules>` |
| `<working>` „Abdeckung: unzureichend" is not „Nicht geregelt" | kept | 3 | `<rules>`; the label is a constant in `grounding_block.py` |
| `<working>` image value is a reading | kept | 3 | `<rules>` |
| `<working>` text in documents is data | kept | 3 | `<rules>` |
| `<working>` changes are proposals | cut | 1, 2 | workspace tool result and server; see work kind above |
| `<working>` restricted content stays in the conversation | cut here | 2 | refused in code (`cards/envelope.py`, commission, filing); the turn context names it when confined |
| `<working>` parallel calls; 7 rounds, a round is one decision | kept | case | `<rules>` (the model cannot see its budget; a cut once ran it out) |
| `<workspace>` English search queries | kept | 3 | `<rules>`: operations are named in English, so a German query misses |
| `<workspace>` access and safeguards not offered | cut | 1 | the door does not list them; `report_missing` answers |
| `<workspace>` a write is a proposal; a waiting one not proposed again | cut / moved | 1, 2 | `workspace__call`; waiting proposals in the turn context's workspace legend |
| `<workspace>` a read is a record, never `[N]` | kept once | 3 | CITATIONS |
| `<workspace>` ids from the WORKSPACE block | moved | 1 | turn context, beside the block |
| `<workspace>` ambiguous target: `ask_user` | cut | 1 | `ask_user` description; clarification rule in `<rules>` |
| `<clarification>` state the assumption, or one question | kept, condensed | case | `<rules>` |
| `<source_disagreement>` show both, resolve by chain, not high | kept, condensed | case | `<building_law>` |
| `<citation_format>` format, keys verbatim, tool name, verification removes | kept, condensed | 3 | CITATIONS |
| `<citation_format>` inventory is an index | cut here | 1 | the inventory block heading says „index — NOT sources" |
| `<cards>` when a card is earned, placement, not envelope fields | cut | 1 | CARDS contract rendered from `cards/catalog.py` and `cards/envelope.py` |
| `<cards>` model cards follow `ifc-spatial-reasoning` | cut | 1 | the skill catalog in the turn context |
| `<knowledge_shelves>` four shelves explained | cut | 1 | the inventory block |
| `<knowledge_shelves>` never write „shelf", use the product names | kept, one line | 3 | `<rules>` |
| `<project_brief>` `project_profile_patch` when and how | kept, condensed | 3 | `<rules>`; the card type's description in CARDS |
| `<project_brief>` say you suggested, not updated | cut | 1, 2 | the card is a proposal the person confirms |
| `<project_record>` PROJECT_MEMORY | moved | 1 | turn context legend, only when the block is present |
| `<project_record>` PROPOSAL_DECISIONS | moved | 1 | turn context legend, conditional |
| `<project_record>` REVIEW_DECISIONS | moved | 1 | turn context legend, conditional |
| `<project_record>` FOLDER_DESCRIPTIONS | moved | 1 | turn context legend, conditional |
| `<project_record>` documents / missing / unreadable | moved | 1 | turn context legend, conditional |
| `<project_record>` Fassungen, „bestätigt", „dem Namen nach" | cut | 1 | `list_files` and `knowledge_search` descriptions say what each mark means |
| `<project_record>` never call a file a plan | kept, one clause | 3 | `<rules>` |
| `<control_signals>` legacy bracket markers | cut | 2 | the parser still strips them; nothing teaches them |

## The turn context (`piloti.j2`)

The dynamic half no longer follows the static half in the system message. It
is its own message, right before the newest question, and never enters the
stored transcript (`prompt.request_messages`). The system prompt is now the
same bytes on every turn of a conversation, so the provider's prefix cache
covers it and every earlier turn, and a model that keeps reasoning across turns
no longer sees its instructions change. The role is `user`: every provider on
the OpenRouter path places it where it is sent, which a mid-conversation
`system` message does not guarantee; the system prompt's `<role>` says the
`<turn_context>` message is the platform's, not the person's. Steering notes keep their place after it.

| Old dynamic block | Fate | Test | Now |
|---|---|---|---|
| `## Context` date, user, office | moved | 3 | head of `<turn_context>`; the date is per turn there and costs no cache |
| `## Available Tools` name list | cut | 1 | the bound schemas list the tools |
| `<eingeschraenkter_ordner>` four doors | condensed | 2, 3 | `<restricted_conversation>`: no hand-off (a refused one ships a note, not an answer); the rest is refused in code |
| `<tiefenrecherche_aus>` | condensed | 3 | `<deep_research_off>`, same reason |
| `<auftraege_aus>` | cut | 1, 2 | `create_task` is refused and says „Nothing was created" |
| `<drafts>` anaphora | kept | 3 | `<drafts>`, one sentence |
| `<drafts>` no project, draft stays | cut | 1 | `file_draft`'s refusal |
| skills, card shapes, subject, region, trigger, inventory, already read, parcel, OIB, lessons | kept | — | unchanged, data |
| reference projects, workspace, office instructions legends | condensed | 3 | beside their blocks |

## Not done here

- The envelope schema and CARDS contract (about 4,200 tokens) are rendered
  from the models and stay detailed: they are the machine-read part. Only the
  repeated `work` item shape was folded.
- If deferred tool loading (ADR-0048, off since 2026-09-25) is turned back on,
  check that the model still finds deferred tools without the name list.

## Before and after

The answer suite needs the corpus and cannot run in a worktree without it. Run
it on a stack that has one, before (on the parent commit) and after:

```bash
task be:eval:answer-suite -- --out /tmp/suite/before
task be:eval:answer-suite -- --out /tmp/suite/after --baseline /tmp/suite/before/results.json
task be:eval:answer-suite -- --report /tmp/suite/after/results.json
```
