# Docked panels: a list beside the real surface

A list of things to work on (the Postfach, and next Offene Punkte, Aufgaben,
search results) sits **beside** the real surfaces its entries open, never with
a copy of those surfaces inside it. Following an entry replaces the page next
to the list with the entry's own place, at full strength; the list stays. Why,
and the options rejected: [ADR-0148](../adr/0148-a-list-is-worked-beside-the-real-surface-never-a-copy.md).

This page is how to build one.

## The pieces

| Piece | Where | What it owns |
|---|---|---|
| `DockedSplit` | `apps/workspace/ui/components/ui/docked-split.tsx` | A page with a panel docked at its `start` or `end` edge: the same tree open or not, expand then resize, constant bounds, the width committed once per gesture, dragged shut means dismissed, double-click restores the default width, the restore tab |
| The start dock | `apps/workspace/ui/components/shell/start-dock.ts` | Which panel is docked at the page's start edge (`StartDockPanel`), its width, per tab and per device; `useStartDockDoor` for the links that open it; `useStartDockShown` for overlays that must leave it usable |
| The shell's slot | `AppShellChrome`'s `startDock` prop, filled by `app/app/(shell)/layout.tsx` | Wraps `<main>` in the start `DockedSplit`; publishes `--page-inset-start` / `--page-inset-top` while a panel is docked |
| `PageDialog` | `apps/workspace/ui/components/ui/page-dialog.tsx` | A dialog that belongs to the page: modal alone, not modal beside a docked panel |

The file peek beside the chat is the same primitive at the other edge
(`FilePreviewBridge`, `side="end"`); read it for an end-edge panel.

## Docking a new list

1. **Name the panel.** Add it to `StartDockPanel` in `start-dock.ts` (one panel
   docks at a time) and accept it in `restore()`.
2. **Build the panel's content** in its feature: a header with its title and a
   close (`useStartDock((s) => s.close)`), and the list. Every entry is a
   **link** to its real place (`next/link`), so a phone, a new tab and a screen
   reader get a real link. Mark the current entry from the address, not from
   stored state (the Postfach's `isAtHref`), so it is right however the reader
   got there.
3. **Hand it to the shell** in `app/app/(shell)/layout.tsx`:
   `startDock={{ inbox: …, yourPanel: canSee ? <YourDock /> : undefined }}`.
   The shell never imports a feature; a panel the reader may not open is absent.
4. **Give it a door.** The link that already leads to the list's own page
   takes `useStartDockDoor('yourPanel')`: `onClick` on the link,
   `aria-expanded={door.open}` and `data-dock-door={door.panel}`. Never mark it
   active; active is the page the reader is on.
5. **Make it a disclosure.** Opened by the reader, the panel takes the focus
   (`takesFocus` in the store, cleared with `focusTaken()` once it has), so its
   keys work at once; restored after a reload it leaves the focus with the
   page. Escape and its close button put it away and hand the focus back to
   the door (`focusStartDockDoor`, which finds the door by its
   `data-dock-door`). Give the panel's root `tabIndex={-1}` so a click on its
   background focuses it too.
6. **Keep its keys to itself.** Docked beside a page with keys of its own (the
   review's C, P, Escape), the list listens only while focus is inside the
   panel: mark the root `data-queue-keys` and the Postfach's
   `keyScope="self"` listens anywhere inside it.
7. **Let it arrive, not jump.** Fade the panel's content in from a few pixels
   off its edge (`motionEntrance`); never animate the panel's width, which
   would re-lay out the page beside it on every frame. Rows that come and go
   take their height (`HeightArrival as="li"` inside
   `<AnimatePresence initial={false}>`).

Below `lg` (`DOCK_LAYOUT_QUERY`) nothing docks: the door follows its link to
the list's own page, and an entry opens in its place.

## An overlay that belongs to the page

A docked panel is beside the page, not behind it. An overlay the page opens
(an artifact looked at with full attention: the review, the file preview)
covers the page and leaves the panel usable:

* A Radix dialog: use `PageDialog` / `PageDialogContent` instead of `Dialog` /
  `DialogContent`, and give a full-page layout the page's edges:
  `top-[var(--page-inset-top,0px)] left-[var(--page-inset-start,0px)]`, height
  `h-[calc(100dvh-var(--page-inset-top,0px))]`.
* A hand-built fixed overlay: offset its scrim and centre its card with the same
  two variables (the file preview's card is the example).

Both variables are unset while nothing is docked, so the `0px` fallback keeps
the whole window and nothing changes for a reader without a docked panel. An
app-level question (a confirm, the command palette) keeps the plain `Dialog`
and covers everything, as it should.

## What not to do

* **Do not draw the entry's surface in the panel.** No thread, chat or preview
  re-implemented beside the list: open the real one. A copy lacks half of its
  original and drifts from it on the first change.
* **Do not move an overlay in the DOM to fit beside the panel.** The file
  preview's panel is one element across parked, peek and modal; a portal
  remounts it. Position with the page-inset variables.
* **Do not switch the page's wrapper when the panel opens.** `DockedSplit`
  keeps the page the first panel's child either way; a conditional wrapper
  remounts the page and loses its drafts.
