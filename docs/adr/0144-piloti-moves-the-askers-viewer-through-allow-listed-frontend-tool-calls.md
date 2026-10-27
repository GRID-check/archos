---
status: proposed
date: 2026-10-27
decision-makers: Grid engineering; the generative-UI plan's slice 5, approved by the product owner on 2026-10-27
consulted: the intelligent-UI research of 2026-10-27 (AG-UI 1.0.3, CopilotKit frontend tools, A2UI 0.14, MCP Apps 2026-01-26)
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

The standards call this a frontend tool: the agent names a tool the client
declared, with arguments, and the client runs it on the person's screen
(AG-UI 1.0 `TOOL_CALL_*` with client-declared tools, CopilotKit
`useFrontendTool`). The same research names the risk: a frontend tool that can
do anything is a remote control for the screen, and the agent door must never
offer one (ADR-0122 withholds "a person's own screen state").

## Decision Drivers

* The person decides what is on their screen. Piloti proposes; the page runs
  it, announces it, and can take it back.
* Nothing opens that the person could not open from Files: the BFF's document
  visibility decides, in the person's own session, at the moment it moves.
* No outside agent drives a person's screen, and neither does a spectator's
  stream, a replay after a reload, or another tab.
* One viewer. An action moves the viewer the person's own clicks move.
* Industry vocabulary on our wire (ADR-0068), and a wire addition small enough
  not to collide with the subagent frames being added beside it.

## Considered Options

* **A. An allow-listed viewer action, one `CUSTOM viewer_action` event in AG-UI's frontend-tool shape.**
* **B. AG-UI's `TOOL_CALL_START / ARGS / END` with client-declared tools.**
* **C. A card the person clicks (the status quo, look cards and citations).**
* **D. Open-ended UI commands (navigate to any route, scroll, click).**
* **E. A door operation another agent may call.**

## Decision Outcome

Chosen option: **A**, because it is the frontend-tool pattern with the one
property B lacks on our wire: a complete, typed, checked call in one frame.

**The allow-list** (`wire_v2.ViewerActionName`, mirrored by the generated zod):

| Action | Needs | What the asker's page does |
|---|---|---|
| `open_document` | the document, a page optionally | opens it in the chat peek |
| `highlight_passage` | page, passage (≤ 400 chars) | opens it at the page with the words marked |
| `highlight_region` | page, `[x, y, w, h]` | opens it at the page with the box marked |
| `compare_revisions` | an older Fassung on the same shelf | offers the Fassung comparison |
| `focus_ifc_element` | an `.ifc` model, an IFC GlobalId | offers the model view with the element selected |

**The path.**

1. Piloti calls `show_in_viewer` (`tools/viewer/register.py`), chat only. It
   resolves the document as `look` does and reads it once through the BFF as
   the person (the canvas route's `list`, which loads the row with
   `findDocumentForSession` and admits it against the conversation's audience).
   A refusal goes back to the model and no event is sent.
2. The tool emits `CUSTOM viewer_action` with `{tool_call_id, tool_call_name,
   args}`: AG-UI's field names, one frame. Nothing returns to the agent: the
   person's screen is not the agent's state, so there is no tool result to wait
   for, and the tool tells the model not to claim the screen moved.
3. The fold keeps the calls on the turn (`turn-fold.ts`); only the driver of the
   page that **asked** the turn hands them on (`use-websocket-chat.ts`). None
   is stored with the answer.
4. `viewer-actions.ts` runs it when the person allows it and is not typing.
   Before anything moves, the runner asks `GET /api/documents/{id}/viewer-place`,
   which reads the document (and the older Fassung) with `getListedDocument`,
   the read `GET /api/documents/{id}` uses. A 403 or 404 moves nothing and the
   row says the document is not theirs to see.
5. The row under the answer says what moved, with „Zurück“ (the viewer as it
   was), or offers „Anzeigen“ when it did not move. Its switch is the person's
   choice, kept per browser, and starts off when the system asks for reduced
   motion.

**What runs on its own and what only offers itself.** The peek actions run.
The comparison covers the conversation and the model view leaves it, so those
two are always offered and run on a click (WCAG 3.2.5, change of context on
request). An action that arrives while the person types waits for a pause of
1.5 s, at most 8 s, and is then offered. Nothing calls `focus()`.

**A citation is the same action.** A citation of a stored document offers
„Neben dem Chat öffnen“ in its dialog, which builds the same call
(`citationViewerAction`: its box, else its words, else its page) and runs it
through the same runner and the same BFF gate.

**On the doors.** `document-viewer-place-get` is catalogued and withheld,
`ui-state`, from every door, Piloti's included: Piloti proposes with its native
tool, and no agent calls the gate of someone else's screen.

### Consequences

* Good, because „S. 4“ in an answer becomes the page itself beside the chat,
  with the sentence marked, and nothing extra to click.
* Good, because a forged or replayed event opens nothing: the page re-asks the
  BFF in the person's session, and only the asker's live page acts at all.
* Good, because the allow-list is a closed enum on both sides; a new action is
  a wire change with its own review, its own fixture and its own row here.
* Bad, because the row is not kept with the answer: after a reload the answer
  no longer says what moved. That is deliberate (it described a moment on one
  screen), and the citations still open the same places.
* Bad, because the peek shows nothing on a phone, so there every action is
  offered rather than run, and the comparison and the model view never run on
  their own anywhere.
* Neutral, because an older bundle reads the event as an unknown `CUSTOM` name
  and passes over it (chat-wire-v2.md, Compatibility).

### Confirmation

* `tests/aiq_agent/common/test_wire_v2.py` (`TestViewerAction`) pins the
  allow-list and what each action needs; the recorded turn
  `shared/wire/v2/turn-viewer-action.jsonl` is read by both suites.
* `tests/aiq_agent/tools/viewer/test_register.py`: a document the BFF refuses,
  a name the turn cannot see, a run without an envelope and a corpus file send
  no event.
* `viewer-place/route.spec.ts`: a document or an older Fassung the person may
  not see is a 404; `viewer-action-runner.spec.ts`: a 403 or 404 moves nothing.
* `use-websocket-chat.spec.ts`: a turn this page did not ask runs no action.
* `exposure.config.spec.ts` holds the withheld entry; `parity.config.spec.ts`
  and `test_surface_parity.py` hold the `showInViewer` capability.

## Pros and Cons of the Options

### B. AG-UI `TOOL_CALL_START / ARGS / END`

* Good, because it is AG-UI's own frontend-tool transport, word for word.
* Bad, because our wire uses `TOOL_CALL_*` for nothing on purpose:
  chat-wire-v2.md §a rejects it because it "implies streamed arguments and
  results", and a step never carries either. The premise: our producer has the
  whole checked call before it sends anything, and expects no result. If AG-UI
  adopts a single-frame tool call, or we start returning a result (a person's
  "not now" fed back to the model), B becomes the better fit.
* Bad, because three frames per call and a client-side argument assembler buy
  nothing a validated single frame does not have.

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
* Wire: `src/aiq_agent/common/wire_v2.py` (`ViewerActionValue`),
  `docs/design/chat-wire-v2.md` §a.
* User guide: `docs/user-guides/chat.md`, "Piloti takes you to the place".
* Not in this slice: the Herleitung row of a viewer action (the action is no
  step), and returning the person's "not now" to the model.
