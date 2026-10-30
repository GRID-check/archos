---
status: proposed
date: 2026-10-30
decision-makers: product owner
consulted: the Postfach redesign session (2026-10-29/30)
informed: everyone who builds a list that opens things (the Postfach, Offene Punkte, Aufgaben, search)
---

# A list is worked beside the real surface, never a copy of it: one docked-panel primitive, and page overlays that leave it in view

## Context and Problem Statement

The Postfach lists what waits on the reader: a mark assigned to them, a
colleague's question in a chat, Piloti's Rückfrage. Each entry belongs to a
real surface with its own full behaviour: the project chat (composer,
@-mentions, @Piloti's live answer, attachments, presence) and the document
review (the plan, the pins, the thread, edits, assignment, dates, Piloti's
pointer). Working the list meant opening an entry, leaving the Postfach, and
reopening it for the next one.

The first redesign put a detail pane beside the list and drew the entry's
thread in it: a second, smaller thread, read with the same client, answered
through the same writes. It looked right and was wrong. It lacked edits,
assignment, dates, presence and Piloti's live answer; every change to the real
thread would have had to be made twice; and the two would have drifted on the
first one that was not. The product owner's words for the requirement were
"no copies": the place an entry opens must be the real one, with all of its
functionality.

Two facts of the code decide how. The chat is one app-wide store
(`useChatStore`: the current conversation, the current project), not an
instance a panel could mount twice: a second chat inside the Postfach would
switch the chat page behind it. The review is driven by the page's address
(`?review=1&mark=…`) and drew itself as a full-window modal over everything.

## Decision Drivers

* **One implementation per surface.** A surface shown in two places drifts;
  the design language already says "one viewer per kind of thing viewed".
* **The real place, at full strength.** Whatever opens from the list has every
  capability it has on its own page, because it is that page.
* **The list stays while the work happens.** Working a queue means the next
  entry is one click away, without reopening anything.
* **Nothing remounts.** Opening or closing the panel must not remount the page
  (a chat draft, a Files selection, an upload in flight are lost by a remount).
* **Reusable.** The file peek already docked a document beside the chat. A
  second docked panel must be the same primitive, not a second implementation.

## Considered Options

* **A. A detail pane with a copy of the entry's surface** (the first build).
  Rejected because it is a second implementation of the thread and of the chat,
  which the drivers forbid; it was built, judged and deleted.
* **B. Make the chat and the review mountable anywhere** (per-instance chat
  store, an address-free review). Rejected because the chat's state is one
  store read by most of the chat feature; making it per instance is a rebuild
  of that feature, weeks of work, for no capability the reader lacks under C.
* **C. Dock the list beside the page, and let each entry open its real page
  in the page area.**
* **D. A parallel route slot (`@dock`) for the list.** Rejected because a slot
  keeps its state on soft navigation only while no route in it matches, so it
  cannot be closed without a catch-all that then matches every navigation and
  resets it; the shell's own header rejects a catch-all slot for the same
  reason.

## Decision Outcome

Chosen option: **C**, because it is the only one with no second
implementation, and it reuses what the file peek had already learned.

How it is built:

* **`DockedSplit`** (`ui/components/ui/docked-split.tsx`): a page with a
  collapsible panel docked at its start or end edge. It owns what every docked
  panel needs: the same tree whether open or not (the page never remounts),
  expand-then-resize when it opens, constant bounds, the width committed once
  per gesture, dragged shut means dismissed, double-click restores the default
  width, a restore tab on the edge it left by. The file peek beside the chat
  is its end-edge user (`FilePreviewBridge`); the Postfach is its start-edge
  user.
* **The start dock** (`ui/components/shell/start-dock.ts`): which panel is
  docked at the page's start edge and how wide, kept per tab (open) and per
  device (width). The shell (`AppShellChrome`) wraps `<main>` in the start
  `DockedSplit`; the app layout hands it the panels (`startDock={{ inbox }}`),
  so the shell imports no feature. Its doors (`useStartDockDoor`) are links
  that open the panel with a plain click where it fits (`DOCK_LAYOUT_QUERY`,
  `lg`) and follow the link otherwise; open is said as `aria-expanded`, never
  as active, which is the page the reader is on.
* **The list is only a list.** Every Postfach entry is a link to its real
  place; following one replaces the page beside the dock. Which entry is
  current is read from the address (`isAtHref`), not stored.
* **Page overlays cover the page, not the panel.** While a panel is docked
  the shell publishes where the page begins (`--page-inset-start`,
  `--page-inset-top`; unset otherwise). The overlays that belong to the page
  (the file preview's card and scrim, the review) draw from there, and a
  dialog that belongs to the page is a **`PageDialog`**: alone, the ordinary
  modal; beside a docked panel, not modal, no scrim, and working the panel
  does not close it. Nothing is moved in the DOM, so the file preview's
  panel stays one element across parked, peek and modal.

### Consequences

* Good, because the chat and the review the Postfach opens are the real ones,
  so every capability they gain reaches the Postfach without a line of inbox
  code.
* Good, because the next list that opens things elsewhere (Offene Punkte,
  Aufgaben, search results) docks with `startDock` and a door, and inherits
  the width memory, the restore tab and the page overlays' behaviour.
* Good, because the file peek's hard-won mechanics are stated once, where the
  next docked panel finds them.
* Bad, because opening an entry is a navigation: the page beside the dock
  loads as it would from the rail, and an unsaved draft on the page being
  left is only as safe as that page's own guard.
* Bad, because the review is no longer always full-window: beside the
  Postfach it covers the page area and leaves the dock interactive, which the
  design language's "what is behind it does not matter" no longer covers.
  The design language says so in its overlay table.
* Bad, because the two page-inset variables are a contract between the shell
  and any overlay that wants to respect a docked panel; an overlay that
  ignores them covers the dock as before (correct for app-level questions,
  wrong for a page's artifact).
* Neutral: on a phone, and below `lg`, nothing docks; the Postfach is its page
  and an entry opens in its place, as before.

### Confirmation

* `ui/features/documents/components/file-preview-split.spec.tsx` holds the
  split's mechanics (bounds, expand-then-resize, once-per-gesture width, the
  restore tab) on `DockedSplit` through its first user.
* `ui/components/shell/app-shell-chrome.spec.tsx` holds that the shell docks
  only what the layout handed over and only where there is room, publishes
  and clears the page's edge, and never remounts the page.
* `ui/components/shell/start-dock.spec.ts` holds the doors: a plain click
  opens the panel where it fits; a modified click or a narrow window follows
  the link.
* `ui/features/documents/components/review/document-review.spec.tsx` holds
  that the review alone is modal with a scrim, and beside the Postfach has no
  scrim and is not closed by touching the panel.
* `ui/features/collaboration/components/InboxQueue.spec.tsx` holds that every
  entry is a link and that the current entry is read from the address.
* The seam rule (`bun run lint:seams`) keeps the shell free of feature
  imports: the panels arrive through `startDock`.
* **Nothing enforces "no copies" itself.** A new pane that re-draws a chat or a
  thread instead of opening it would pass every check above; review is the
  gate, with this record and the design language's overlay table as the rule.

## More Information

* The design language's overlay table: a panel docked beside the page is not
  behind anything ([`design-language.md`](../design/design-language.md#overlays-pick-by-what-the-content-is)).
* How to dock a new panel: [`docked-panels.md`](../architecture/docked-panels.md).
* The Postfach's queue (what waits, grouped by document, most urgent first):
  `ui/features/collaboration/lib/inbox-queue.ts`.
