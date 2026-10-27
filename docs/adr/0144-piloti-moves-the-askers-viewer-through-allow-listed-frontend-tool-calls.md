---
status: proposed
date: 2026-10-27
decision-makers: Grid engineering; the generative-UI plan's slice 5, approved by the product owner on 2026-10-27
consulted: the intelligent-UI research of 2026-10-27 (AG-UI 1.0.3, CopilotKit frontend tools, A2UI 0.14, MCP Apps 2026-01-26); an independent review of PR #1239 on 2026-10-27
informed: everyone working on the chat wire, the document viewer and the agent door
---

# Piloti moves the asker's viewer through allow-listed frontend tool calls

## Context and Problem Statement

When Piloti answers „Laut Baubeschreibung S. 4 …“, the person's next move is to
go there. Until now that was a click on a citation, which opens a dialog over
the chat, or on a look card's thumbnail. Piloti could make a box glow on the
review canvas for everyone in a document (`canvas__highlight`, ADR-0128), but it
could not take the one person who asked to the place in their own viewer beside
the chat.

The standards call this a frontend tool. The client declares the tools it can
run (AG-UI's `RunAgentInput.tools`), the agent calls one with arguments, and the
client runs it on the person's screen (CopilotKit's `useFrontendTool`). The same
research names the risk: a frontend tool that can do anything is a remote
control for the screen, and the agent door must never offer one (ADR-0122
withholds "a person's own screen state").

## Decision Drivers

* The person decides what is on their screen. Piloti proposes; the page runs
  it, announces it, and can take it back.
* Nothing opens that the person could not open from Files: the person's own
  read of the document decides, in their session, at the moment it moves.
* No outside agent drives a person's screen, and neither does a spectator's
  stream, a replay after a reload, or another tab.
* One viewer. An action moves the viewer the person's own clicks move.
* One contract per question (ADR-0055): the page asks with a route that already
  exists, not with a second one.
* Industry vocabulary on our wire (ADR-0068), and a wire addition small enough
  not to collide with the subagent frames being added beside it.

## Considered Options

* **A. An allow-listed viewer action, one `CUSTOM viewer_action` event in AG-UI's frontend-tool shape, bound only when the page declares it.**
* **B. AG-UI's `TOOL_CALL_*` events for the same calls.**
* **C. A card the person clicks (the status quo, look cards and citations).**
* **D. Open-ended UI commands (navigate to any route, scroll, click).**
* **E. A door operation another agent may call.**

## Decision Outcome

Chosen option: **A**, because it is AG-UI's frontend-tool pattern (the client
declares, the agent calls, the client runs) on the wire this product already
speaks. Keeping it a `CUSTOM` event rather than `TOOL_CALL_*` follows
chat-wire-v2 §a, which keeps every tool off `TOOL_CALL_*`; see B.

**The allow-list** (`wire_v2.ViewerActionName`, and the page's own copy in
`viewer-actions.ts`):

| Action | Needs | What the asker's page does |
|---|---|---|
| `open_document` | the document, a page optionally | opens it in the chat peek |
| `highlight_passage` | page, passage (≤ 400 chars, `MAX_VIEWER_PASSAGE_CHARS` on both sides) | opens it at the page with the words marked |
| `highlight_region` | page, `[x, y, w, h]` | opens it at the page with the box marked |
| `compare_revisions` | an older Fassung, linked as one | offers the Fassung comparison |
| `focus_ifc_element` | an `.ifc` model, an IFC GlobalId | offers the model view with the element selected |

The server writes only these names. The JSON Schema, and so the page's zod,
reads `tool_call_name` as a string: a page one release older passes over a
sixth action (`newer-events.jsonl`) instead of refusing the frame and asking
the reader to reload.

**The path.**

1. **The page declares the tool.** With every question, a page whose viewer has
   room beside the chat sends `client_tools: ["show_in_viewer"]`
   (`user_message.client_tools`, AG-UI's `RunAgentInput.tools` by name, sent
   only to a server whose hello accepts it). The server binds the tool for that
   turn only (`common/client_tools.py`, `agents/piloti/register._tools_in_scope`).
   A phone, a tab one release older, a background run and an agent at the door
   declare nothing, and the model is never offered the tool there.
2. **Piloti calls `show_in_viewer`** (`tools/viewer/register.py`). It resolves
   the document as `look` does and reads it through the BFF as the person (the
   canvas route's `list`, which loads the row with `findDocumentForSession` and
   admits it against the conversation's audience), once: when resolving an id
   already read it, that read stands. A refusal goes back to the model, worded
   as the read it is, and no event is sent. A chat attachment is refused before
   any read: it is on no shelf, so the page's own read could never open it. One
   place per turn: a second call is refused.
3. **The tool emits `CUSTOM viewer_action`** with `{tool_call_id,
   tool_call_name, args}`: AG-UI's field names, one frame. Nothing returns to
   the agent, and the tool tells the model not to claim the screen moved.
4. **The fold keeps the calls on the turn** (`turn-fold.ts`); only the driver
   of the page that **asked** the turn hands them on (`use-websocket-chat.ts`).
   None is stored with the answer.
5. **Nothing moves before the answer.** The page holds each action while the
   turn runs and releases them when it finishes `answered` with text; an error,
   a Stop, a refusal or a hand-off drops them. A retracted stream
   (`answer_retracted`) is a round, not the answer, and neither releases nor
   drops. Of the released actions, one moves the viewer; any other is offered.
   A held action is not hidden: once the answer's first words are on screen
   its row says it waits for the finished answer, and „Anzeigen“ opens it at
   once. That press is the person's and counts as the answer's one move.
6. **The page reads the document again before anything moves**, with
   `GET /api/documents/{id}` (`document-get`), the read Files and every agent
   door already use. A 403 or 404 moves nothing, and the row says neutrally
   that the document is not available. A comparison reads both documents at
   once and runs only for two Fassungen of one document: one shelf (`projectId`,
   `collectionName`) and linked as Fassungen in `revision` (the links a person
   confirmed, ADR-0099).
7. **The row under the answer** says what moved, with „Zurücknehmen“, or offers
   „Anzeigen“ when it did not move. An undo says whether it put anything back:
   the peek as it was, unless the person opened another document since; the
   comparison shut, only if it is still the one this action opened; the page
   the person came from, only while they are still in the model view (the same
   page and model, whatever element or camera they moved to there). Once they
   have left it the row drops „Zurücknehmen“ rather than navigate anywhere.
   Only the status text is a live region.

**What runs on its own and what only offers itself.** The person's switch
(„Automatisch öffnen“, under the latest answer that proposed a place and on the
profile page, per browser, off at the start under reduced motion) is what makes
an automatic move a change the person asked for. With it on, the peek actions
run. The comparison covers the conversation and the model view leaves it, so
those two always wait for „Anzeigen“: a new context is opened only on a click
(WCAG 3.2.5). An action released while the person types waits for a pause of
1.5 s, at most 8 s, and is then offered. With no room beside the chat at the
moment of „Anzeigen“, the same pane opens over the chat (`mode: 'modal'`).
Nothing calls `focus()`.

**A citation is the same action.** A citation of a project or Büroablage
document offers „Neben dem Chat öffnen“ in its dialog while a viewer has room
beside the chat. It builds the same call (`citationViewerAction`: its box, else
its words, else its page) and runs it through the same runner and the same read.
A chat attachment does not offer it.

**On the doors.** There is no route of its own to withhold. `document-get` is
the read, and it is already offered on every door: an agent learns from it what
it could learn before, and moves no one's screen. The tool is Piloti's own and
exists only for a turn whose page declared it.

**Measured.** The page records each outcome (`viewer_action_outcome`: action,
outcome, reason) and each change of the switch (`viewer_actions_auto_changed`)
in PostHog, by kind only (`docs/observability/posthog-events.md`). The tool
records what became of each call as a step span (`show_in_viewer`: action,
outcome). Together they answer whether a proposed place is shown, refused,
undone or switched off.

### Consequences

* Good, because „S. 4“ in an answer becomes the page itself beside the chat,
  with the sentence marked, and nothing extra to click.
* Good, because a forged or replayed event opens nothing: the page reads the
  document again in the person's session, and only the asker's live page acts.
* Good, because the tool is in a turn's tool payload only where it can run, so
  no model is taught a tool its page cannot carry out.
* Good, because the allow-list is closed on the server and open on the reader:
  a new action is a wire change with its own review, its own fixture and its
  own row here, and it does not force old tabs to reload.
* Bad, because the row is not kept with the answer: after a reload the answer
  no longer says what moved. That is deliberate (it described a moment on one
  screen), and the citations still open the same places.
* Bad, because a turn with the tool bound and one without have different tool
  payloads, so an organization has up to four prompt-cache shards (project or
  not, viewer or not) instead of two.
* Bad, because a chat attachment never opens beside the chat: the read the page
  makes lists shelves, and an attachment is on none. Supporting it means giving
  that read a session-scoped path, a separate change.
* Neutral, because an older bundle reads the event as an unknown `CUSTOM` name
  and passes over it (chat-wire-v2.md, Compatibility).

### Confirmation

* `tests/aiq_agent/common/test_wire_v2.py` (`TestViewerAction`) pins the
  allow-list and what each action needs; the recorded turn
  `shared/wire/v2/turn-viewer-action.jsonl` is read by both suites, and the
  unknown action in `newer-events.jsonl` is refused by the server and read by
  the page (`wire-v2.spec.ts`).
* `tests/aiq_agent/tools/viewer/test_register.py`: a document the BFF refuses
  (worded as a read), a name the turn cannot see, a run without an envelope, a
  corpus file, a chat attachment, a turn whose page declared nothing and a
  second call send no event; an id is read once.
* `tests/aiq_agent/agents/piloti/test_register_decisions.py`: the tool is not
  bound for a turn that declared nothing; `tests/aiq_agent/turn/test_payload.py`:
  the declaration is per turn.
* `viewer-action-runner.spec.ts`: a 403 or 404 moves nothing; a comparison of
  unlinked or cross-shelf documents is refused; no room opens the pane as a
  dialog; each undo says whether it acted.
* `use-websocket-chat.spec.ts`: actions wait for the answer, a failed turn drops
  them, one place moves, a turn this page did not ask runs none, and the page
  declares the tool only with room.
* `parity.config.spec.ts` and `test_surface_parity.py` hold the `showInViewer`
  capability; `test_product_framing.py` holds every tool description to the
  rule that a file is never called a plan.

## Pros and Cons of the Options

### B. AG-UI `TOOL_CALL_*`

AG-UI carries a tool call as `TOOL_CALL_CHUNK`, one frame the client expands to
`TOOL_CALL_START` / `ARGS` / `END`, and `TOOL_CALL_RESULT` is optional. So
neither streamed arguments nor a result is forced on the producer, and the
transport itself would fit.

* Good, because it is AG-UI's own frontend-tool transport, word for word, and a
  generic AG-UI client would recognise the call.
* Bad, because this wire keeps every tool off `TOOL_CALL_*` (chat-wire-v2 §a):
  the steps a person reads are `STEP_*`, and a tool frame beside them would be
  a second way to say a tool ran. One event under AG-UI's field names keeps §a
  whole.
* The premise that would change it: once the page sends something back to the
  model (the person's "not now", or the place they opened instead), the call
  has a result, and `TOOL_CALL_CHUNK` with `TOOL_CALL_RESULT` is the better
  carrier. That is the trigger for moving, together with §a.

### C. Cards only

* Good, because nothing moves without a click.
* Bad, because the click is the whole cost the feature exists to remove; and
  the person who wants that keeps it with the switch off.

### D. Open-ended UI commands

* Bad, because a command set the model composes is a remote control: any
  route, any scroll, any click. The research's own warning (CopilotKit's
  frontend tools are code the app registers one by one) is that the allow-list
  is the safety, not a limitation.

### E. A door operation

* Bad, because ADR-0122 withholds a person's own screen state from every
  agent, and a screen another agent can move is a screen the person no longer
  controls.

## More Information

* Research: the intelligent-UI landscape of 2026-10-27 (§ "Frontend tools,
  narrowly"), which proposed one `CUSTOM` event and the parity entry.
* Wire: `src/aiq_agent/common/wire_v2.py` (`ViewerActionValue`,
  `UserMessage.client_tools`), `docs/design/chat-wire-v2.md` §a.
* User guide: `docs/user-guides/chat.md`, "Piloti takes you to the place".
* Not in this slice: the Herleitung row of a viewer action (the action is no
  step), returning the person's "not now" to the model, and opening a chat
  attachment beside the chat.
