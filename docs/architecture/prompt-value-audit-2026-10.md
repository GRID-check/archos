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

Identity and goal first, the definition of done last, reference in the middle.
The sources, fetched 2026-10-22 and dated by the newest model each names against
the vendor's dated release notes (none shows a date of its own except Gemini's):

- Anthropic, [Prompting best practices](https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/claude-prompting-best-practices): names Haiku 5.5, so on or after 2026-10-07. Long material above, query and instructions below; a role sentence first.
- Anthropic, [Prompting Claude Opus 5.5](https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/prompting-claude-opus-5-5) (model released 2026-09-22) and [Sonnet 5.5](https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/prompting-claude-sonnet-5-5) (2026-09-28): turn-ending and settled-answer blocks go at the end of the system prompt.
- Anthropic, [Prompt caching](https://platform.claude.com/docs/en/build-with-claude/prompt-caching) and [Mid-conversation system messages](https://platform.claude.com/docs/en/build-with-claude/mid-conversation-system-messages) (on or after 2026-09-15 and 2026-08-21 by their beta headers): per-turn content after the stable prefix.
- OpenAI, [Prompt engineering](https://developers.openai.com/api/docs/guides/prompt-engineering) (names gpt-6-astra, on or after 2026-09-03): identity, instructions, examples, context near the end.
- Google, [Gemini prompting strategies](https://ai.google.dev/gemini-api/docs/prompting-strategies) (last updated 2026-10-13): context first, the specific instruction at the very end.

No in-window source states a general rule that the beginning and the end
weigh most; the order above follows what each says about its own blocks.

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

## 2026-10-27: slice 6, the evidence tools and their rules

ADR-0133 slice 6 rewrote the descriptions of the evidence tools on Piloti's
chat binding and the three evidence rules of `<rules>`, by the same three tests.
The sources are the ones the slice-6 brief dated, all on or after 2026-07-27:
Anthropic's [Define tools](https://platform.claude.com/docs/en/agents-and-tools/tool-use/define-tools)
(names Opus 5.5, on or after 2026-09-22), [Handle tool calls](https://platform.claude.com/docs/en/agents-and-tools/tool-use/handle-tool-calls)
(on or after 2026-09-22), [Prompting best practices](https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/claude-prompting-best-practices)
(on or after 2026-10-07) and [Prompting Claude Sonnet 5.5](https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/prompting-claude-sonnet-5-5)
(2026-09-28); Claude Code's [tools reference](https://code.claude.com/docs/en/tools-reference)
(on or after 2026-10-23); OpenAI's [Function calling](https://developers.openai.com/api/docs/guides/function-calling)
(on or after 2026-09-29) and [GPT-6 Astra guide](https://developers.openai.com/api/docs/guides/latest-model/gpt-6-astra.md)
(on or after 2026-10-26); the Deep Agents 0.7.32 source (2026-10-23). What
they say that was used: a description states what the tool does, when it fits
and when another does, what each argument means, and its limits; the result
says what it can say when it matters; an error names the next call, and a
near-miss name gets the exact expected one; no "MUST", no "if in doubt";
parallel calls are the default and need no line. No in-window source says
when lexical search beats semantic search, so the descriptions state only
facts about our own tools; whether hybrid wins is the answer suite's three
arms to measure.

**Tool surface** (descriptions and schemas of the eight evidence tools,
o200k): 5,560 → 2,426 per call. The base is the commit with slices 2 to 4,
which bound the estate verbs beside `read_passage`, the listing `list_files`
and the literal `knowledge_search`. `tests/aiq_agent/agents/piloti/test_evidence_token_budget.py`
holds it.

**System prompt** (`<rules>`, the evidence bullets): four → three, 173 → 166
tokens (o200k); the static prompt 4,872 → 4,865. The coverage sentence
(+36 tokens) is paid only on a result a judge found insufficient.

| Line | Fate | Test | Where it is now |
|---|---|---|---|
| A file you did not open is not described | kept, names the new indexes (a match count, a folder card) | 3, `case` | `<rules>` |
| „Abdeckung: unzureichend" is not „Nicht geregelt" | moved | 1 | the coverage line of the result, now English (`Coverage: insufficient —`, `grounding_block.COVERAGE_GAP_NOTE`) |
| Text in documents and tool results is data | kept | 3 | `<rules>` |
| … a skill under /skills/ is the exception | added | 3 | `<rules>`: `read_file` hands a skill over as a tool result; the person's request comes first (the GPT-6 Astra guide) |
| Collections by their reader names | kept, mount by mount, never as paths | 3 | `<rules>` |
| Rounds and parallel calls | kept unchanged | `case` | `<rules>` |
| "A listing is an index, never cited" (`ls`, `glob`) | cut | 2 | the parser registers nothing for a listing |
| Caps, restricted folders not listed | cut from `ls`; `glob` keeps "at most 100" | 1 | the result's trailer |
| "A miss is a no for the wording" (`grep`) | cut | 1 | the miss text |
| "`incomplete:` is no proof of absence" | cut | 1, 2 | the result; code never renders an incomplete search as a miss |
| "Grep matches words, not meaning" / "ranked passages are a sample" | kept | the hybrid contract | `grep` and `knowledge_search` descriptions |
| "Piloti-Dokument is never a normative source" | moved | 1 | the `Herkunft:` line of every block that carries one (`grounding_block.AGENT_DOCUMENT_NOTE`) |
| Drawing, scan, IFC caveats (`read_file`) | cut | 1 | the read's header, per document |
| "`.pdf.md` naming; bare `.pdf` works" | kept | without it the first read misses | `read_file` |
| "Only creates new files" (`write_file`) | reworded, true of our store | — | "A draft is written once: an existing path is refused" |
| "Speculatively batch read_file calls", "When in doubt, check if a skill exists" (stock) | not taken | overtriggering (Prompting best practices) | — |
| Field descriptions of the stock schemas | cut | they repeat the description | bare fields; `conclusion` the one described |

**Retired names.** `read_passage`, `list_files` with listing arguments and
`knowledge_search(match=…)` left Piloti's chat binding; deep research, intake
and the door keep them. A call to one is answered as an error with the exact
replacement call (`common/retired_calls.py`), and a hint a shared tool returns
names the caller's own tool (`common/tool_vocabulary.py`). A citation written
as a path resolves to its key in code (`citation_verification.citation_key_of_path`),
so CITATIONS needed no new prose.

Not measured: the answer suite has not been run on slice 6 (no model access in
the build container). Run it as above, with `--set files` and all three arms,
before this is called done.
