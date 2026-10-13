# File upload, progress, and the document explorer

**Date:** 2026-08-11
**Status:** Implemented
**Surfaces:** project Files workspace, org Büroablage (the same workspace, see the last section), chat-session uploads
**Preview:** `/dev/upload-tray`

## The complaint

> "The uploads progress bar is not really a progress bar. It always gets stuck on
> the same thing."

It was literally true. The bar's value was:

```ts
const value = file.progress > 0 ? file.progress : isFailed ? 0 : 15
```

`15` is not a measurement. It was a constant standing in for a number nobody had
taken, because the upload went out over `fetch`, and **`fetch` cannot report
request-upload progress** — the browser exposes no event for bytes leaving the
machine, only for bytes arriving. So for the entire upload the bar sat at 15%.
Then `progress` started arriving from the ingest job, which reports in bursts as
the backend works through a queue, so the bar held one value for a long time and
then jumped.

Two different unmeasurable phases were being drawn on one determinate track. That
is a modelling fault, not a rendering one, and no amount of easing fixes it.

## The rule

> **A percentage is drawn only where bytes are actually moving.**

Everything else — waiting for an upload slot, waiting for the backend to read a
document — gets motion and an elapsed time instead. That is not a smaller
promise; it is the true one. `lib/upload-progress.ts` encodes it as
`isDeterminate(phase)`, and every bar on the surface asks it before choosing a
track. The accessible half is the same: an indeterminate `role="progressbar"`
omits `aria-valuenow`, which is exactly what ARIA reserves it for.

The phase model:

| phase | what the user is waiting for | measurable? |
|---|---|---|
| `queued` | a free upload slot | no — elapsed only |
| `uploading` | bytes leaving the machine | **yes** — real byte percentage |
| `processing` | the backend reading and indexing | no — sweep + elapsed |
| `ready` / `held` / `stored` / `failed` / `canceled` | nothing | terminal |

Two terminal phases are neither a success nor a failure:

- **`held`**, „Zurückgehalten“ (“Held back”), in the warning colour: the content
  check held the file back (ADR-0086). The row lists what was found
  (`QuarantineFindings`, without page buttons, because the tray cannot show
  the document). It can be dismissed and is **never** retried, not by the row
  and not by „Fehlgeschlagene wiederholen“: a re-upload onto a held file is
  refused (409), and nothing went wrong to repeat. A batch with a held file in
  it does not retire itself, the header says „1 Dokument zurückgehalten“ or
  „2 hinzugefügt · 1 zurückgehalten“, and its glyph is a warning shield unless
  something also failed.
- **`stored`**, „Abgelegt“ (“Filed”), muted: the bytes are kept and nothing
  read them (the document's `uploaded` / `stored` status). Not „Zitierbar“,
  because Piloti cannot cite it. The header counts it as added.

A fresh file the server refuses because the document it would replace waits in
the Quarantäne (409, `details.reason: quarantined`, `assertMayReplaceHeld`)
ends `failed`, but with `retryable: false` on the row and the sentence in the
reader's language („… ersetzt eine Datei, die in der Quarantäne wartet …“). A
retry would meet the same 409 until somebody deletes or releases that file, so
`retryFile` refuses it, and every surface that offers a retry asks
`mayRetryUpload` (`features/documents/types.ts`), the same rule that keeps a
held row from being retried.

Every path that settles a row agrees on these. The ingest job poll reads a
`failed` file whose error starts `quarantined:` as held
(`trackedStatusOfJobFile` in `features/documents/utils.ts`); a status read maps
by the status's read family (`trackedPatchFromStatus`), so a `quarantined`
document is held and an `uploaded` one stored; the upload response's
`uploaded` is stored unless the answer is *unchanged*. The chat says the same:
the attachment card and the composer chip show a held file with a warning
shield and the quarantine sentence and offer no retry, and a stored one as
„Abgelegt“, because the chat cannot answer from a file nobody read. A re-list
of a chat's attachments keeps both: the listing's file status
(`ListedFileStatusSchema`) has `stored` and `held` beside the backend's four
words, and `sessionDocumentFileStatus` reads them off the one state table
(`surfaceStateOf`). Only a citable attachment is `success`, the status the
no-sources banner and the composer count as an available source; an
undeclared status is at rest and is not one.

`queued` and `uploading` are told apart by `uploadStartedAt`, not by the byte
count: with a bounded number of slots most of a large batch is genuinely
waiting, and a file that has a slot but has not fired its first progress event is
still uploading. Guessing from bytes conflates the two and makes the ninth file
of nine look stalled at zero.

The batch bar tracks **bytes, not file count**. A typical batch is one 150 MB IFC
model and a dozen 200 KB PDFs; a count-based bar leaps to 92% and then appears to
hang for a minute — the same lie in a different costume.

## What changed in the transport

| | before | after |
|---|---|---|
| Progress | none (`fetch`) | real bytes (`lib/http/xhr-upload.ts`) |
| Concurrency | serial `for … await` | 3 in flight (`lib/upload-queue.ts`) |
| Cancel | none at all | per file and whole batch |
| One file fails | batch aborts at that file | that row fails, the rest continue |
| Client upload paths | two (XHR *and* `fetch`, drifted) | one shared helper |

The serial loop was the expensive part. Each POST also writes to object storage,
checks the org storage quota and dispatches to the ingest API, so a twelve-file
Einreichung took the **sum** of twelve round trips on a link that was idle for
most of each one. Three at a time collapses wall-clock toward the slowest single
file. Three, not more: browsers allow six connections per host and the
ingest-status poll shares that budget, and beyond three the per-file rate just
divides — a single upload already saturates a typical office uplink.

Progress events are coalesced (`shouldEmitProgress`) to one percent of the file,
floored at 64 KB. The browser fires them every ~50 ms per request; without the
gate, three concurrent uploads meant sixty store writes a second to move a bar by
a third of a pixel.

## Nielsen's heuristics, applied

The surface was designed against the ten usability heuristics rather than
decorated afterwards. Where each one landed:

1. **Visibility of system status.** The whole point. Real byte percentage, phase
   named in words, transfer rate, ETA, elapsed time; the headline sits in an
   `aria-live="polite"` region so phase changes are announced while the
   per-second byte counter never is.
2. **Match between the system and the real world.** "Waiting", "Sending",
   "Reading", "Citable" — not `pending`, `ingesting`, `success`. "Citable"
   tells a planner whether Piloti can use the file in an answer, which is what they check first. Sizes, speeds and
   durations are formatted in the app's locale, not the runtime's.
3. **User control and freedom.** Cancel one file, cancel the batch, retry one,
   retry all failed, dismiss. A held file is dismissed, never retried. Before this change there was **no way to cancel an
   upload at all** — a 150 MB model uploaded by mistake had to be waited out.
4. **Consistency and standards.** The same extension chip identifies a document
   in the tray, in the explorer list and in the preview header. Status wording
   comes from the one `document-status` map, through the seven states of
   `lib/documents/surface-state.ts`: a file whose bytes are still arriving says
   „Wird hochgeladen“, not „Wird gelesen“, and is counted with the files being
   read. The badge takes its colour from the same state, so a failed row that
   still carries the content check's verdict (`quarantined:{…}`, written before
   the reconcile said `quarantined`) reads „Zurückgehalten“ in the warning
   colour wherever the caller holds the row's `errorMessage`. The upload
   summary counts a status nobody declared as being read, as the folder brief
   does. Indeterminate progress follows the ARIA pattern rather than inventing
   one.
5. **Error prevention.** Validation still runs before a byte is sent; the
   concurrency cap keeps the connection pool from starving the status poll; a
   per-file abort handle means cancelling one file cannot cancel another.
6. **Recognition rather than recall.** Every file the user dropped appears as a
   named row immediately — before any network call — so nobody has to remember
   what was in the selection. The explorer's sorted column is marked with an
   arrow *and* `aria-sort`.
7. **Flexibility and efficiency of use.** Three views (cards / list / folders),
   remembered per browser. The list is fully keyboard-navigable with a roving
   tabindex, and sorts filenames with a numeric collator so `Plan_2` precedes
   `Plan_10` — a set of drawings is numbered, and lexicographic order scatters it.
8. **Aesthetic and minimalist design.** A settled row collapses to a single line,
   so a batch visibly gets quieter as it lands instead of holding twelve
   animating bars. A wholly successful batch retires itself after six seconds.
   The preview pane lost a footer band that restated the page count already in
   the rail.
9. **Recognize, diagnose, recover.** The server's own reason ("File exceeds the
   100 MB upload limit") lands on the row that owns it, with retry beside it. A
   cancelled file reads as a decision, not a failure — it never colours red.
10. **Help and documentation.** The processing line says *"Reading. There is
    no time estimate, so you can keep working."*, which is the help a user needs
    at exactly the moment they would otherwise sit and watch. When the tray
    stops following a job (its 35-minute budget ran out, or the job store no
    longer knows it), the row stays *Reading* and a notice says reading
    continues in the background. It is never reported as a failed upload. The
    orchestrator keeps a slow per-document status poll for such a row
    (`watchDocuments`, every 60 s) until it is final, and an open workspace
    settles it sooner (`useSettleTrackedUploads`, from the listing or, for a
    row the current filter hides, from its own status).

Beyond Nielsen:

- **Doherty threshold.** Rows appear on drop, before the collection is even
  resolved — the acknowledgement is never behind a network call.
- **Goal-gradient.** Byte-based batch progress moves smoothly rather than
  jumping, so the sense of approach is continuous.
- **Peak–end rule.** The journey ends on a confirmation ("12 documents added",
  plus the per-document *citable* toast) rather than on a bar that vanishes.
- **Jakob's law.** The tray is the transfer panel every browser and file manager
  already has; the detail view is the Explorer/Finder list every professional
  already knows.
- **Fitts's law.** Row actions and list rows grow their targets under
  `pointer-coarse`. So do the sort headers, the upload tray's expand control and
  the preview's tag field — all of which were mouse-sized until they were
  measured rather than read.
- **The list truncates rather than scrolls.** The detail view is a real `<table>`
  and it is `table-fixed`, which is what makes the `truncate` on every filename
  cell mean anything: under the browser's default auto layout a column is sized
  to its content's minimum, a filename does not wrap, so the Name column laid out
  437px wide inside a 308px phone wrapper and the reader had to drag the list
  sideways to find out what a document was called. Dropping the reference
  columns at `sm`/`md`/`lg` never touched that — it removes the columns that were
  not the problem. Anything added to this table declares a width, or it is the
  one `w-auto` column that absorbs what is left.

## The preview pane

Same lens, applied to the surface that opens when a document is clicked:

- **The AI summary is promoted.** It is the answer to "does the agent actually
  understand this file" and it used to be one more 12.5px paragraph read at the
  same weight as the MIME type. It now sits on its own raised card under its own
  section label.
- **One fact list, not two.** Type and size used to sit in a separate block
  *below the tags*, divorced from the page count they belong with, purely because
  one group was behind a feature flag and the other was not. The flag now gates
  **rows**, which is what it was always about.
- **The document sits on something.** A soft vertical ground with the page raised
  on a real shadow, instead of a flat grey box — which is what a drawing on a
  desk looks like, and the reason this column exists rather than a download link.
- **The fake page is gone.** The "no inline preview" state used to draw skeleton
  paragraph bars — permanently, for a file whose contents cannot be shown at all.
  That is decoration pretending to be content; on a file surface a reader
  glancing at it sees "a document" and moves on. Skeleton bars now appear only
  while a preview is genuinely loading.

## The card of a document that is still being read

**Preview:** `/dev/file-browser?variant=uploading`

> "Whilst uploading, but the preview is already available, it looks weird."

The preview being there was never the problem — a PDF thumbnail is produced at
upload time while the rest of ingestion runs after it, so a card can legitimately
show its page render under a *Processing* badge. What looked wrong was the tile
around it.

An unsettled document has **no AI summary yet**. Its settled neighbours do, so
they are taller, and a CSS grid row is as tall as its tallest cell — every other
cell stretches to match. `FileCard` filled that stretched cell with a
fixed-height content block, so the leftover height collected at the *bottom*:
the `size · time` footer floated in the middle of the tile with a band of dead
surface underneath it, and the footers in a row did not line up. The card looked
half-drawn at exactly the moment the user was watching it most closely.

Two things changed, and the order matters:

- **The description slot is held, not left blank.** Two skeleton bars occupy the
  two lines the summary will land on, exactly as the thumbnail well shows a
  skeleton while its request is in flight. An empty gap reads as a card that
  failed to render; a skeleton says the sentence is coming. It is `aria-hidden`
  — the badge beside the thumbnail already says *Processing* in words, and a
  screen reader should hear that once rather than twice. It is shown only for a
  settling status: a `failed` document shows its reason, and a settled document
  with genuinely no summary shows nothing rather than a bar that will never fill.
- **The raised white block is `flex-1`**, so it absorbs whatever height the
  stretched cell has left and the footer tab sits on the bottom edge of every
  card. A skeleton is close to the height of the sentence it stands in for but
  never exactly it, and a two-line summary next to a one-line one has the same
  problem — so the row still needs the block to grow. The same block in
  `DocumentGridCard`'s unresolved tile got the same treatment, for the same
  reason. This is a property of the shared card, so the Büroablage (which draws the same `FileCard`, with its gold kind chip passed in) is fixed by the same change.

**The second half of the same moment:** the thumbnail cache treated "no
thumbnail" as permanent. If the page rendered a second before the backend
produced the preview, the card cached that miss for the whole page lifetime and
kept the sketch placeholder until a reload — the settling poll refreshed the row
but never re-asked the route. A miss for a document whose status is still
settling (`isSettlingStatus`, now shared with the poll in
`document-status.tsx`) is now provisional: it is evicted, and the status
transition to `ready` re-asks. Terminal statuses keep the cached miss, so a
document that genuinely has no thumbnail still costs one request.

## One byte formatter, one byte convention

There were two functions computing the same quantity differently:
`formatBytes` (decimal, 1000-based) and `formatFileSize` (binary, 1024-based).
So a 1,048,576-byte document read as **1.0 MB** on its card and contributed
**1 MB** to the org's storage figure, and an administrator's 1 GB quota rendered
as 0.93 of itself. Each copy looked locally correct, which is what makes a fork
like this survive.

The mismatch went deeper than display. Upload ceilings were computed as
`MB * 1024 * 1024`, so `FILE_UPLOAD_MAX_SIZE_MB=100` actually admitted
104.9 MB — while the storage quota beside it used `BYTES_PER_GB = 1e9`. The
binary formatter then printed that binary limit as "100.0 MB", so the two errors
cancelled and the inconsistency stayed invisible. Fixing either half alone makes
the enforced limit and the sentence describing it disagree, so both moved:

- `formatBytes` is now the only byte formatter (`lib/format.ts`), absorbing the
  nullable input and the `0 B` zero case the deleted one handled. The byte tier
  is the one place Intl does not own the unit word — CLDR's short form for
  `byte` is the literal word ("878 byte"), which reads as a typo in a column of
  "4.8 MB".
- `BYTES_PER_MB = 1e6` (`shared/config/request-body-limit.ts`) now backs the
  document ceiling, the IFC ceiling, the transport limit and the client-side
  fallback constants, matching `BYTES_PER_GB` on the storage side.

**Behavioural consequence, stated plainly:** the effective upload ceiling drops
~4.9% (104.86 MB → 100.00 MB for a deployment configured at 100), and likewise
the IFC ceiling (262.1 MB → 250.0 MB). That is the limit becoming the number the
administrator actually configured. Raise the env var if the old headroom was
being relied on.

## The folder brief and the read state of a folder

**Preview:** `/dev/folder-brief`

At the Jour fixe of 2026-10-09, feld72 raised three things. The read state of
nested folders was not visible. Answers called documents missing that had been
read. And checking folder by folder did not scale. The folder brief and the
state on each folder row answer all three from the listing the Files view
already holds.

The brief sits above the file list at every folder level, in Dateien and in the
Büroablage. It describes the folder and everything below it, not only the level
on screen. It is folded by default to one muted line, the headline and its scope
(„35 von 44 Dokumenten gelesen in diesem Projekt“), with no border, bar or
legend. Open by default, the card took the top third of every folder for a
status most people opening a folder were not asking about.

The line is the card's header in both states, and it opens in place: a click
leaves it where it is, fades the card's border in around it, and opens the bar,
legend and sections below it. A first version swapped the line for a separate
card with its own heading, so the thing just clicked disappeared and its words
came back elsewhere in another size. The fold is remembered per browser, as the
card and list choice is.

| Part | What it says | Each count opens |
|---|---|---|
| Bar and legend | How many documents in the subtree Piloti has read, and where the rest of those it is meant to read stand: read, being read, failed, held back. The legend adds up to the headline's „von N“. Documents Piloti never reads follow as an aside, „dazu 1 nicht in der Wissensbasis“, outside the sum. | The flat list of that state, across all subfolders |
| What needs a person (first, open) | Failed documents, with one button to read all of them again. Documents held back by the content check. Citable documents Piloti placed in no document type. Each „Anzeigen“ has its own accessible name. | The flat list of those documents |
| What it is about (folded) | The document types and disciplines Piloti assigned to the citable documents, each family under its label („Dokumentart“, „Fachbereich“), most frequent first, and the kinds of content it found. „Sonstiges“ always comes last. Then the topics Piloti recognised (up to twelve), and for photos the span of days the camera says they were taken on. Folded, its line names the types. A long chip truncates and carries its full text on hover. | The flat list of documents with that tag or topic, or of the dated photos |
| Where it sticks (folded) | Up to four subfolders, worst first, whose own documents need attention or are being read. Each is named by its path, so the reader lands on the folder with the trouble and not on an ancestor. | Walks into that folder |

The order is what the reader has to do: what needs them first and open, then
„Was Piloti noch fehlt“, „Worum es hier geht“ and „Wo es hakt“, each folded to
one line that already names what it holds. Opened in full the brief was taller
than a laptop screen, and the listing it introduces started below the fold.

The brief counts one entry per document, as the listing shows it (ADR-0099): an
older Fassung whose newer one is in the corpus is left out of every count, the
pages, the chips, the failures and the re-read, whatever the „Ältere Fassungen“
filter says.

At the project root only, a fifth part, „Was Piloti noch fehlt“, lists the
documents the intake answers say the project should hold and that no file is
bound to yet. These are the entries the agent reads as its missing documents. A
file that is in the project but not yet bound to its role still shows here as
missing, because Piloti cannot tell which file it is until it is bound.

The re-read button appears only for a reader who may write in that folder,
because a re-read changes the document for everybody who can open it. It sends
the same request as a document's own „Erneut lesen“, four at a time, and each
row turns to „Wird gelesen“ as its answer comes in.

**Folder rows in the list view** show the worst state of everything in their
subtree, as one swatch and one phrase, in this order: failed, held back, being
read, and then „Alles gelesen“ when every document Piloti is meant to read is
citable. The folder tiles of the card view carry the same mark as a coloured dot
beside the name, without the words, which are its tooltip and its screen-reader
text: the card view is for browsing, the list view is the detail view, and the
phrase on every tile was louder than browsing needs. For the same reason a file card carries a status
badge only when the document is not simply citable (being read, failed, held
back, never indexed); „Zitierbar“ is spelled out in the list view's status
column. An unplaced document is not named on a row. It appears only in the
brief's „Where it sticks“, because on most folders of a project it would be
noise. An empty
folder, or one holding only documents Piloti never reads, shows nothing.

**Where the data comes from.** Nothing is fetched for the brief or the rows.
The browser computes both from the listing the Files view already loads:
`buildFolderBrief` for the folder on screen, and `subtreeTallies` for every
folder at once, in one pass over the documents. The one extra request is
`GET /api/projects/{id}/document-roles`, which supplies the missing list. The
browser reads it again whenever a document in the tab changes. The Büroablage
has no project, so it makes no such request and shows no missing list.

**Content of unreadable documents is never shown.** The brief takes what it says
about a document only from citable documents. A document that is failed, held
back, still being read, or not in the knowledge base is counted. Its tags,
disciplines, content kinds and summary stay out of the brief. A document the
content check has not released cannot reach the reader through the brief.

## Fassungen: a suggestion, then a person's link

feld72 asked for „eine Logik wie bei Planfred“: only the newest state of a
document is the basis, the older ones only on request, and any automation only
as a suggestion a person confirms, also when a new state does not carry the
old file name. ADR-0099 records why this is a link between two documents and
not a merge.

Piloti suggests in two ways:

- **By name.** Each file carries the name-based suggestion, computed when its
  listing is read, so a document uploaded before this existed is still asked
  about, on the file. The agent's `list_files` reads index and date with the
  same grammar, twins held to one fixture
  (`tests/fixtures/revision_series_cases.json`).
- **By reading.** After a new document is read, a model compares its summary
  with the documents it could replace, name matches first, and keeps a
  suggestion only above a confidence threshold. The preview names the basis:
  the name, or what Piloti read.

The preview's one section „Fassungen und Freigabe“ (`document-fassungen.tsx`,
below) asks the question. „Ja,
neuere Fassung“ links the two, and „Nein“ is remembered, so the same pair is not
suggested again. Once linked:

- the older document says it is replaced;
- the agent's search leaves it out unless a turn asks for it by name;
- the newer document shows „Was sich geändert hat“, a model's reading of both
  summaries, with the caveat that dimensions are checked in the document.

A same-name re-upload (ADR-0054's version chain) gets the same change line
against its previous version.

**One section, not two: „Fassungen und Freigabe“** (`document-fassungen.tsx`,
mounted once in `file-preview-pane.tsx`, directly under Piloti's reading).
It replaced „Fassungen“ (the older documents linked under other names) and
„Freigabe und Fassungen“ (this document's own uploads and the approval
controls, last in the rail), which described one history in two places.

- **Header, always visible, about the NEWEST Fassung only** (`lib/fassung-standing.ts`):
  „Fassung 2 · In Prüfung“; the track with its four stages named (Entwurf, In
  Prüfung, Freigegeben, Veröffentlicht), the last one reached in ink; the next
  step with a person („Nächster Schritt: Freigabe durch Sabine Gruber“, from the
  open round's recipients, `reviewerUserIds` on the version listing; „Ihre
  Freigabe“ when it is the reader's; „ein Teammitglied“ only when the name is
  unknown); and which Fassung Piloti answers from, in one sentence. When that is
  an older one, the sentence names it by number („Piloti antwortet weiter aus
  Fassung 1.“), so the header and the rows cannot contradict each other. A
  person's upload, born published without a review, gets no state word and no
  track; a Fassung a newer document replaced is „Ersetzt“, without a track.
  Under the header, when a decision is the reader's: „Freigeben“ and
  „Änderungen anfordern“ visible, „Piloti überarbeiten lassen“ and „Ablehnen“
  behind ⋯, and one line on what approving means.
- **Body, a disclosure:** the suggestion card, then ONE timeline, newest first and
  numbered „Fassung 3, 2, 1“ (`buildFassungTimeline`) across the uploads under
  this name (`useDocumentLifecycle`) and the older documents under other names
  (`file.fassung.history`), merged by date. An older Fassung that was opened has
  the newer document as its top row. The index or date is a secondary tag;
  „aktuell“ marks only the Fassung Piloti answers from; no row says „Ersetzt“.
  Each fact once: the person and date on the act line („Hochgeladen von Anna
  Berger · 14.08.2026“; an upload never reads „Freigegeben“), a file name only on
  a row that is another document, cut in the middle (`MiddleTruncate`). One
  visible action per row (Öffnen); Herunterladen, the line diff, Vergleichen and
  „Verknüpfung lösen“ (a direct predecessor, `canManage`) behind its ⋯. Two
  Fassungen that cannot be laid over each other (text, Markdown, CSV) get
  „Textvergleich öffnen“ in the comparison dialog, which shows their line
  comparison under the row (`GET /api/documents/{id}/text`, `lib/documents/text-client.ts`).
  „Datei stilllegen …“ is one quiet line at the end; its confirm lists what it
  does.
- **It opens itself** on the attention edge, once: a decision is this reader's to
  take (`lifecycleNeedsReader`), Piloti has an unconfirmed suggestion, or the file
  is an older Fassung. A reader who closes it keeps it closed.
- **Surfaces without lifecycle permissions** (the Büroablage sheet, the chat peek)
  get the same section with the cross-name timeline and the suggestion, and no
  controls; the uploads under the name are read only when the listing says there
  is more than one.

Preview: `/dev/fassungen` (nine states at the rail's real 248px, `?locale=en`), `/dev/document-lifecycle`.

**Looking at two Fassungen together** (`fassung-compare/`, „Fassungen
vergleichen“). A full-screen dialog with three views: *Nebeneinander* (two
sheets that scroll and zoom as one; stacked on a phone, each fitted to half the
height), *Überlagert* (older inked cyan, newer orange, multiplied, so unchanged
lines go dark and changes keep a colour; the colour key, with the computed
swatch for „unverändert“, and the fader sit in a bar under the sheet, only in
this view) and *Wischen* (a draggable divider in a fixed near-black ink with a
white halo, so it shows on the white sheet in dark mode too, and „Älter“ /
„Neuer“ tags with the file names on each side of it). The toolbar keeps one
height in every view; on a phone it is two rows, with the view names spelled
out. Keys: ← → and Page Up / Down turn the page, Home and End go to the ends, 1
2 3 switch the view, Esc closes; the dialog opens with focus on the view
switch, reads the keys through its description and gives focus back to the
control that opened it. Zoom says „Einpassen“ when the whole sheet fits and a
percentage of that fit otherwise (up to 800 %); Ctrl or Cmd + wheel and a
two-finger pinch zoom at the pointer, dragging pans. File names are cut in the
middle (`MiddleTruncate`, `lib/text/middle-truncate.ts`) from where the two
names first differ, so the index survives. Both pages are drawn at one scale
in a shared box; when the page counts differ the dialog says so. „Seite N mit
Piloti vergleichen“ asks the vision comparison for that page
(`useFassungVisualChanges`); each answered page is kept, so marking page 2
keeps page 1's boxes. The boxes are numbered outlines in the mark ink (dashed
in the overlay) on the newer sheet, and the list beside it (under it below
1024 px) groups them by page, with Piloti's sentence under its box's label when
the counts pair, and the caveat that dimensions are checked in the document.
Boxes and rows are one selection: hovering or focusing either lights both (a
tooltip names the box), clicking a row turns to its page and scrolls its box
into view. A refusal names the remedy and offers a retry where one can help
(409: still being read; 502/503: Piloti not reachable). Boxes already known can
be passed as `overlays`; a run replaces them. PDFs and office files (through
their PDF rendition) are drawn with the preview's pdf.js runtime, images from
the preview URL; a page load that fails names the file and offers „Erneut
versuchen“, anything that cannot be drawn shows „Diese Dateien lassen sich
nicht visuell vergleichen“ with „Textvergleich öffnen“ (when the surface passes
`onOpenTextCompare`) or „Zum Fassungsverlauf“. A surface mounts it with
`useFassungCompare(loadSource?, { onOpenTextCompare? })`
(`openFassungCompare(older, newer, overlays?)` plus `{compareElement}` once).
A link can open it too: `?doc=<newer>&compare=<older>` on the files page, which
the inbox's „Fassungen vergleichen“ uses (`use-compare-param.ts`).
Preview: `/dev/fassung-compare`.

**Names are never more than the reader may see.** The BFF resolves each linked
name to a document the reader can open. A reference to a held, restricted or
archived document is dropped, not shown (`lib/documents/fassung.ts`).

**Naming.** No surface calls a file a plan. A name with an index says a file
has Fassungen, not that it is a drawing (CONTEXT.md, „Fassung“), and
`src/i18n/forbidden-file-words.spec.ts` holds the copy to it.

## Where the code lives

| Concern | Module |
|---|---|
| Byte-level upload transport (the only XHR in the app) | `src/lib/http/xhr-upload.ts` |
| The folder brief: a folder's subtree tally, the brief, what each count selects | `src/features/documents/lib/folder-knowledge.ts`; `src/features/documents/components/folder-brief.tsx` |
| Revision series read from file names (TS twin of `sources/knowledge_layer/src/revision_series.py`) | `src/lib/documents/revision-series.ts` |
| The preview's Fassungen und Freigabe section; the timeline rule; the lifecycle data; the link request | `src/features/documents/components/document-fassungen.tsx`; `src/features/documents/lib/fassung-timeline.ts`; `src/features/documents/hooks/use-document-lifecycle.ts`; `src/features/documents/lib/fassung-request.ts` |
| A folder's read state: the dot on its tile, the dot and phrase on its list-view row | `src/features/documents/components/folder-read-state.tsx` |
| Bulk re-read, four requests at a time, and the one request each sends | `src/features/documents/hooks/use-bulk-reingest.ts`; `src/features/documents/lib/reingest-request.ts` |
| The missing list, shared with the agent's prompt | `src/lib/document-roles/prompt-loader.ts` (`loadMissingDocuments`); `src/features/documents/hooks/use-missing-documents.ts` |
| Phase model, batch summary, rate/ETA estimator | `src/features/documents/lib/upload-progress.ts` |
| Bounded-concurrency batch runner | `src/features/documents/lib/upload-queue.ts` |
| Explorer ordering (numeric collator, status rank) | `src/features/documents/lib/file-sort.ts` |
| Upload surface | `src/features/documents/components/upload-tray.tsx` |
| Explorer detail view | `src/features/documents/components/file-list-view.tsx` |
| The shared document card (grid anatomy, thumbnail loading) | `src/features/documents/components/file-card.tsx` |
| Status semantics + the settling predicate both the poll and the card read | `src/features/documents/components/document-status.tsx` |
| Orchestration (validation, fan-out, cancel, polling hand-off) | `src/features/documents/hooks/use-file-upload.ts` |

The logic is in plain modules with their own fast specs rather than inside the
components, per the note on `InputArea.spec.tsx` in `AGENTS.md`: the entire
progress model is exercised without a clock, a DOM or a React tree.

## What this does not change

- The backend ingest pipeline and its job-status API are untouched. The
  `progress_percent` it reports is still stored on the tracked file; it is simply
  no longer drawn as a bar, because it is not a position.
- Session (chat) uploads now take the same per-file path as the other shelves,
  to `/api/session/documents/upload` (ADR-0047 Phase 2), so they get per-file
  bytes, cancel and failure too. They used to send the whole batch as one
  multipart request straight at the ingestor.
- The chat's file dialog (`FileSourcesTab`) deletes only the chat's own
  attachments. With the project chosen as the destination it lists the project
  files but offers no delete, and says to delete them in the project's files:
  a project document is shared, and its delete (legal-hold check, every
  version's objects) belongs to the Files workspace, where the document's
  context is. The dialog's old delete did nothing anyway: it sent a document id
  to the proxy's chunk-only file delete, which expects a filename.
- Validation, quotas, tenancy and authorization are unchanged.

## One workspace, two shelves

**Date:** 2026-10-06 · **Surfaces:** project Files workspace, org Büroablage

The Archiv was a flat card grid (`ArchivLibraryPane`) beside a 1,600-line project
workspace, and every capability the project got (folders, drag to move, folder
upload, list view, filters, sort, `?doc=`) had to be built a second time. The
Archiv now has all of them because it is the same component.

`FileWorkspace` (`features/documents/components/file-workspace.tsx`) takes a
`FileShelf` descriptor (`lib/file-shelf.ts`). `ProjectFileWorkspace` and
`ArchivWorkspace` are adapters that build one and supply the header. Shared, and
therefore no longer able to drift: `useLevelListing` and `useShelfSummary`
(one folder level page by page and the shelf's counts, ADR-0102),
`useFileListing` (the paged drain with its generation guard and settling poll,
now the fallback), `useFolderTree` (load, create, rename,
move, delete, with the `files` strings), `useDocumentMoves`, `useShelfUpload`
(the plan, the ensure request, moves of unchanged documents, `folderIdFor`),
`useFolderParam` (`?folder=`), `useViewPreference` (`grid.files.view`),
`useFileSearch` (takes the shelf's search route), `usePreviewChannel` and
`useDocParamSync` (`?doc=`), `useModelStage` (`?model=`), and the one row mapper
`toFileItem`.

What a shelf may differ in is exactly the fields of `FileShelf`:

| Field | Project | Archiv | Why it is inherent |
|---|---|---|---|
| `endpoints` | `/api/documents?projectId`, `/api/projects/{id}/folders` | `/api/archiv/documents`, `/api/archiv/folders` | Two stores |
| `canManage` | always | `org:archiv:manage` | Archiv writes are an org permission; a read-only member sees folders, search, filters, preview and download, nothing that mutates |
| `canCollaborate`, `currentUserId` | collaboration flag | off | Assignment is project-scoped |
| `askAbout` | opens the project chat | absent | There is no Archiv chat to open |
| `preview` | `store` (the project shell hosts it; chat shares it) | `dialog` (the sheet has no host) | Where a preview can be mounted |
| `cardExtras` | none | gold kind chip + tag provenance | The Büroablage provenance signal (spec §4) |
| `handoverKey` | project id | absent | `ProjectFileDrop` hands a drop to a project only |
| `messages` | „… in dieses Projekt", „in Piloti’s Wissen" | „… in die Büroablage", „in der Büroablage" | Two sentences naming the shelf |
| header | `ProjectSectionActions` portal | gold identity row, count pill, sheet close | Each frames the same controls |

The tag chips of the old Archiv grid are „Kategorie" in the shared filter menu
(`FileFilters.tags`, any-of), so they work under folders and on every shelf. The
Archiv's semantic search is the pane's own, pointed at `/api/archiv/documents/search`
(`projectSearchScope` / `ARCHIV_SEARCH_SCOPE`); a search is shelf-wide and
escapes the open folder exactly as in Dateien.

**Preview:** `/dev/archiv-library` renders the real workspace over fixtures
(`?state=readonly|loading|empty`, `?folder=f-plan`).

### A ZIP is a folder that has not been unpacked yet

Both shelves accept a `.zip` through the same single entry point as a folder:
`handleUpload` in `hooks/use-shelf-upload.ts`. `lib/expand-zip.ts` unpacks it
in the browser (`fflate`, loaded only when a ZIP is present) into `File`s that
carry a `webkitRelativePath`, the shape `readDroppedTree` already produces, so
the plan dialog, the one-request folder creation and the new-version prompt
need no knowledge of archives. Neither shelf's upload route, allow-list or quota
check changed: the server only ever sees ordinary files.

Three decisions worth keeping:

- **Refuse, never half-take.** The entry count and the unpacked size are read
  from the central directory before anything is inflated; past either ceiling
  (`MAX_ZIP_ENTRIES`, `MAX_ZIP_UNPACKED_BYTES`) the whole archive is refused with
  a sentence. Same argument as the dropped-folder bounds.
- **Members get the MIME type a picker would have given** (`mimeTypeForFileName`,
  from the table the accept-list is built from). The preview routes decide
  whether a document can be previewed from the stored content type, so an
  untyped file would upload and then never preview.
- **`.zip` is offered by the durable pickers and the drop overlay only**
  (`withZipAccepted`, `acceptZip`), not through the accept-list the server
  enforces and not in the chat, where an archive is not a document. `.ifczip`
  stays a model: the pattern needs the dot.

### A big shelf: what loads when

**Date:** 2026-10-12 · **Surfaces:** project Files workspace, org Büroablage

*Superseded for the default view by the next section (ADR-0102): the drain
described here is now the fallback, turned on only for what the server cannot
answer. The rendering points below hold for both.*

Search, filters, folder counts, the brief and the upload plan all read the
listing in the browser, so the workspace still holds every row (up to the
ceiling of 20 pages of 500, with the visible notice past it). What changed is
the cost of getting there and of drawing it:

- **The first page is drawn when it arrives.** `useFileListing` commits each
  page as `fetchListingPages` hands it over (`onPage`) instead of after the last
  one: the skeleton stands only until the first 500 rows are in, and later pages
  are appended behind them. The Files page reads the first page on the server
  and passes its `nextCursor` down (`initialNextCursor`); the workspace
  continues from that cursor (`from`) rather than reading the seeded page again.
- **A reload of the listing on screen does not flash.** A listing the pane does
  not hold yet (first read, a filter flip, a retry) streams in behind a
  skeleton. A reload of the same listing (an upload landed, a folder was
  deleted) keeps every row in place and swaps the answer in whole when it is
  complete. The two asks of one upload (`isUploading` turning false, then
  `onComplete`) are both quiet and coalesce into one drain (`reloadQuietly`).
  The folder tree's re-read after a rename or move no longer brings the
  skeleton back either: only `isFirstLoad` does.
- **`complete` gates conclusions about absence.** `?compare=` waits for the
  whole listing before deciding the older Fassung is not there; `?doc=` already
  waited for its row.
- **A card asks for its thumbnail once it has been on screen** (`useSeenOnce`
  in `FileCard`), not on mount. Before, opening a folder of two thousand
  documents sent two thousand thumbnail requests.
- **Each row's menu is built on the first ask.** `DocumentObjectMenu` starts as
  the tile, the right-click host and a plain ⋯ button. The first right-click,
  long-press, press or Enter/Space/ArrowDown on the ⋯ builds the entries, mounts
  the rename and confirm dialogs and the dropdown (opened by that same press),
  and the row stays live. The move targets are labelled and sorted once per
  tree in the workspace (`sortedFolderDestinations`), not once per row.
- **Unchanged rows do not re-render.** Grid cells (`FileTile`), cards and list
  rows (`FileListRowItem`) are memoised and handed stable callbacks; the
  type-ahead filter over the corpus runs on a deferred query, so the field
  answers every keystroke.
- **Off-screen tiles are not laid out or painted** (`content-visibility: auto`
  on `GridTileShell`). List rows are table rows, which CSS containment does not
  apply to, so the detail view does not get this until it is virtualised.

### A folder level, page by page

**Date:** 2026-10-12 · **Surfaces:** project Files workspace, org Büroablage · **ADR:** [0102](../adr/0102-file-workspaces-load-a-folder-level-by-pages.md)

A Büroablage with more than 2 000 documents in its root still downloaded and
hydrated all of them before the root could be drawn. The workspace now reads
the folder level the reader stands on from the server, a page at a time, and
never drains the shelf for the default view.

- **One level, its first hundred.** `useLevelListing` (`hooks/use-level-listing.ts`)
  asks the shelf's listing route for `folderId=<id>|root&sort=&dir=&limit=100`
  and draws the page. The end of the grid or list carries a `LoadMore` sentinel
  (`components/ui/load-more.tsx`, an `IntersectionObserver` with a 600 px
  margin through `useInView`): reaching it reads the next page from the level
  cursor, one at a time, and a button is always there for a keyboard, an engine
  without the observer, and after a failed page (never retried on its own).
- **A new folder starts over; a new order or search does not flash.** Walking
  into another folder drops the rows and shows the skeleton. Changing the
  order, the status filter or the search keeps the rows on screen until the new
  answer replaces them. Each first-page read aborts the one before it and is
  stamped, so an answer for a level the reader has left is dropped.
- **Order, search and status are the server's.** The sort menu's `added`,
  `name` and `size` are request parameters (`name` is the shown name,
  case-folded by Postgres). The search field narrows the loaded rows at every
  keystroke and asks the server 250 ms after the last one, across the whole
  shelf (`q`, without a folder); it matches file names and renames, and the
  empty result says so and points to Enter for the semantic search over the
  content. The status filter is `state=` (read-state families). „Von Piloti“
  and „auch archivierte“ were already server filters.
- **The folder tiles, the header count and the brief come from the shelf
  summary** (`useShelfSummary`, `GET {list}/summary`): one aggregate per
  folder, folded up the tree in the browser (`talliesFromSummary`,
  `buildFolderBriefFromSummary`), read again after an upload, a move, a delete
  or a re-read. The brief's headline, legend, „Hier sind Sie gefragt“ (with
  „Alle erneut lesen“ over the failed ids the summary names) and „Wo es hakt“
  are the summary's. „Worum es hier geht“ needs what the backend put on each
  document, so a summary-built brief shows the section folded with a „Laden“
  button instead of claiming Piloti recognised nothing; pressing it, or opening
  one of the brief's slices, turns the drain on and the brief is built from the
  whole shelf as before.
- **What still drains the shelf**: a kind, tag, assignment or „Freigabe
  ausstehend“ filter, the status order, and the brief's content facts and
  slices. These read facts Postgres does not hold in the documents table. The
  drain is the unchanged `useFileListing`, `enabled` only for them, with its
  page ceiling and notice.
- **Older Fassungen are hidden per loaded page.** Which document replaces which
  is a link in the backend's index, so an older Fassung whose newer one is on a
  later page shows until that page loads, and the summary counts it.
- **A link to a document no page holds is read by id.** `?doc=` and
  `?compare=` name documents that may be in another folder or far down a long
  one; `useLinkedDocuments` reads each missing id from `GET /api/documents/{id}`
  and pins the row beside the level, so the preview and the comparison open
  without draining. A `403`/`404` settles it as absent. The Archiv's
  `?model=` resolves its file by name the same way.
- **The first paint is the level the URL names.** The Files page reads the
  first page of `?folder=` (or the root) in the default order on the server and
  hands it down with its cursor (`initialFiles`, `initialNextCursor`,
  `initialFolderId`); the workspace uses it once, while the reader is still on
  that level, and reads the next page from its cursor.
- **Uploads, moves and deletes.** An upload settling reloads the level quietly
  (as many rows as are on screen, up to 500, swapped in whole) and the summary.
  A move or delete patches the loaded rows at once and re-reads the summary, so
  the tiles' counts follow.

Still open: a virtualised grid and list, and the kind/tag filters and the
brief's content facts on the server once the backend's tags are mirrored into
Postgres.
