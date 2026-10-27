# Project mail: the E-Mail-Eingang, the E-Mails tab and provenance

**Date:** 2026-10-27
**Status:** Implemented; a UI rework is in progress (marked **W1** below)
**Surfaces:** Dateien › E-Mail-Eingang (`/app/projects/[id]/files/mail`, `…/mail/[mailId]`), the address dialog and the settings card, the „E-Mails“ tab of a Verlauf's preview, the provenance row of a document that came by mail, the Postfach rows
**Preview:** `/dev/inbound-mail?variant=…`, `/dev/inbound-mail-detail?variant=…`, `/dev/inbound-mail-address?variant=…[&dialog=1]`, `/dev/mail-thread?variant=…`, `/dev/inbox?variant=mail`; each with `&locale=en`, and `&chrome=0` hides the variant strip. The variant lists are in each page's header.
**Why:** [ADR-0134](../adr/0134-mail-sent-to-a-project-waits-until-a-person-files-it.md); the flow: [`inbound-mail.md`](../architecture/inbound-mail.md); the words: [`CONTEXT.md`](../../CONTEXT.md#project-mail).

## The rule

> **The server says what a mail asks of a person; the UI shows it.**

Completeness, the defaults (`preselected`), the sender's risk, thread groups
(„wird Fassung 4–7“) and the forwarded-from line are computed on the server
(`lib/inbound-mail/{sender-risk,review-defaults,thread-groups,forwarded}.ts`)
and carried on the views. The UI never derives them, so the app, an outside
agent and Piloti's card see the same mail the same way.

One word per concept (DECISION §3, the i18n file headers say it again):
„E-Mail-Eingang“ is the place, „ablegen“ puts a part into the project,
„verwerfen“ says no to the whole mail, „wiederherstellen“ undoes either for
seven days, the „E-Mail-Verlauf“ is the conversation's document and its states
are „Fassung N“. The sender line names a domain, never a person. Never
„Projektadresse“, „Nachricht“ for an e-mail, or „Abgelegt“ as a mail's state.
English copy calls the place „Project mail“.

## Where it is entered

<!-- W1: entry points may move in the rework; update from handoffs/W1-to-D17.md. -->

- The Dateien header: a ghost link „E-Mail-Eingang“ with a **muted** count
  pill (on the phone, the ⋯ menu entry with the count as a hint).
- A quiet line above the shelf root: „2 E-Mails warten auf Ablage · Ansehen“.
- A muted count on Dateien in the rail and the phone tab bar. The Postfach
  keeps the only ink pill.
- `ProjectMailWaiting` on the project card (`waitingMailCounts`).
- The upload menu „Per E-Mail senden …“ opens the address dialog.
- Settings › Dokumente: the address card (create, „Neue Adresse erzeugen …“,
  „Ausschalten …“; managers only).
- The Postfach rows of the seven notices (`/dev/inbox?variant=mail`).

## The address dialog

The address with „Kopieren“ (`CopyableValue`), „Als Kontakt sichern“ (a
vCard), three rules („Abgelegt wird erst, wenn eine Person es bestätigt.“,
„Jede E-Mail zeigt, ob die Domain des Absenders bestätigt ist.“, „Anhänge
werden auf Schadsoftware geprüft, bevor jemand sie ablegen kann.“), „Anleitung“
(the help page, `/e-mail-eingang/`, `/en/project-mail/`), when mail last
arrived, how many automatic replies were dropped in 30 days, and the office's
own DKIM line: „{n} % der E-Mails Ihres Büros der letzten 30 Tage waren von
Ihrer Domain bestätigt“, or „Ihre Domain signiert ihre E-Mails nicht – so
richten Sie es ein“ linking to the help page's `#dkim`. Derived from rows,
never a DNS probe. A member without the right to manage sees „Bitten Sie
jemanden, der das Projekt verwaltet, sie in den Projekteinstellungen zu
erzeugen.“ Rotation's confirm says that every follow on the project ends.

## The E-Mail-Eingang

<!-- W1: list and detail layout are being reworked; replace this section from handoffs/W1-to-D17.md. -->

**Layout by container, not viewport** (`inbound-mail-workspace.tsx`): a 22rem
list and the detail while the component's own box is wider than 48rem
(`@3xl`); below, list → detail with a back link. The filter lives on the URL
(`?status=handled&outcome=filed|dismissed|expired`, replaced); an opened mail
is pushed.

**The list** („Wartet auf Ablage · Bearbeitet“, Bearbeitet faceted into
Abgelegt, Verworfen, Abgelaufen). A row: the sender's domain, the subject
without `AW:`/`WG:`, the time, „· 3 Anhänge“; a thread chip only for a Verlauf
the viewer may read; suggestion chips; a trust or risk glyph. Mail from an
unconfirmed domain and automatic mail sit in a collapsed quiet group
„Domain nicht bestätigt oder automatisch ({n})“. A followed Verlauf's appended
text shows as „Text dem E-Mail-Verlauf angefügt (Verlauf folgen)“ while its
attachments still wait. Mails of one thread are grouped: „4 E-Mails in
E-Mail-Verlauf „…“ ablegen (wird Fassung 4–7)“.

**Impersonation is a stop** (`riskLevel === 'impersonation'`). In the list the
row reads „Gibt sich als {Name} aus · nicht ablegen“ in red and has no
checkbox: it can never join a bulk decision, nor by the keyboard's X. The
detail opens with a full-width warning above the header („Vorsicht: Diese
E-Mail gibt sich als {Name} aus. …“ or „Vorsicht: Der Name {Name} gehört einem
Mitglied, die Adresse {Adresse} nicht.“, then „So beginnen Betrugsversuche mit
Kontoänderungen. …“). „Verwerfen“ is the primary button; the filing controls
fold behind „Trotzdem ablegen …“ („Nur wenn Sie telefonisch geprüft haben, dass
die E-Mail echt ist.“), and filing still needs „Ich habe geprüft, dass die
E-Mail echt ist. Trotzdem ablegen“.

**The detail**, top to bottom:
1. The header: subject, „Von {Name} ‹address›“, the trust line, flags, the
   forwarded-from line with its toggletip („nicht geprüft“), and „Original
   (.eml) herunterladen“ with „Öffnet sich im Mailprogramm; Bilder von außen
   werden dort geladen.“
2. The content-findings choice, when the text has findings: „Unkenntlich
   ablegen“ (selected), „Als eigenen E-Mail-Verlauf ablegen“, „Ungekürzt in den
   E-Mail-Verlauf“.
3. The text: first lines, „Ganze E-Mail anzeigen“, „Zitierten Text anzeigen“.
   Plain text only; links are inert text with a title naming their domain.
4. The „E-Mail-Text“ row: a checkbox and the target („In E-Mail-Verlauf „…“
   ablegen (wird Fassung N)“, „Als neuen E-Mail-Verlauf ablegen“ with a name
   field). Unchecked: „Das Original der E-Mail wird nach der Ablage gelöscht“.
5. „Anhänge“: checkbox, thumbnail (clean images and PDFs only, drawn
   client-side in the sandboxed viewer; Office files show their tile), the
   name, the scan chip, Piloti's suggestion, and the case notes (duplicate,
   revision, name stop, macro, type mismatch, not accepted, not staged).
6. The decision bar, pinned and safe-area padded: „Verwerfen“ left; right
   „{n} Dateien und den E-Mail-Text ablegen“ / „E-Mail-Text ablegen“ /
   „Nichts ablegen“; „Domain nicht bestätigt. Trotzdem ablegen“ only where the
   server asks for `acknowledgeSender`.
7. After filing, the follow offer: „Diesem E-Mail-Verlauf folgen“ with one line
   of what it does, only when the sender would qualify.

**Piloti's mark** (✦) appears on a folder chip only when the folder is Piloti's
stored suggestion; the rule's default folder for a new Verlauf is a plain chip.

**Bulk**: „{n} ausgewählt · Wie vorgeschlagen ablegen · Verwerfen“, enabled
only when every selected mail is complete (`incompleteReason === null`); it
never carries an acknowledgement and confirms with a dialog grouped by
destination.

**States**, each with its own copy: empty (never received / nothing waits /
nothing handled), loading, load error, suggestion pending („Piloti liest noch
…“), no suggestion, decided by someone else, partial failure, quota full,
closed project („Projekt ist abgeschlossen – wieder öffnen, um abzulegen“,
dismiss possible), expired and dismissed („… · wiederherstellbar bis {Datum}“),
original not clean, feature off (`notFound()`).

**Keyboard** (group `inboundMail`, documented in the cheatsheet only with the
flag): J/K, Enter, X, Space, E „Wie gezeigt ablegen“, ⌫ „Verwerfen“.

**Phone**: rows of at least 44px, visible checkboxes, the detail as a page,
bottom sheets, a stacked decision bar with `env(safe-area-inset-bottom)`,
`text-base`, `dvh`.

## The „E-Mails“ tab of a Verlauf

`features/documents/components/mail-thread/`. A Verlauf's preview rail (the
Dateien modal, the chat peek's „Details“ face, the phone's details sheet) has
two tabs, „E-Mails {n}“ and „Details“ (`rail-views.tsx`); „E-Mails“ is up when
a Verlauf opens. A document is asked whether it is a thread only when it can be
one, a `.md` file or Dokumentart *Korrespondenz*, with one `mail-thread-list
?documentId` call (`use-mail-thread-of-document.ts`).

- **Top**: „{n} E-Mails dieses E-Mail-Verlaufs warten im E-Mail-Eingang ·
  Ansehen“ (only for whoever may file), then the follow control.
- **Follow control** (`follow-control.tsx`): „Sie folgen diesem E-Mail-Verlauf
  bis {Datum}“ with „Verlängern“ (only while the follow can grow at least a day
  within 180 days of its start; otherwise „Folgen gilt höchstens 180 Tage ab
  Beginn. Danach erneut folgen.“) and „Nicht mehr folgen“. Not following: one
  line of what it does and „Diesem E-Mail-Verlauf folgen“, toast „Sie folgen
  „X“ bis {Datum}“ with „Rückgängig“. Others: a count („2 weitere Personen
  folgen“); for a viewer with `managesFollows`, „Wer folgt“ by name with
  „Beenden“ each.
- **One row per mail, newest first** (`mail-thread-entry.tsx`): the heading
  exactly as the document cites it; „ab Fassung N · eingegangen {Zeit}“; trust
  in three words („Domain bestätigt: {domain}“ / „Domain nicht bestätigt“ with
  the warning glyph / „Aus dem E-Mail-Archiv · nicht geprüft“); how it was
  filed only where no person decided in the app (agent, Piloti card, follow,
  archive import); „Anhänge“: each a link to its document, „lag schon im
  Projekt“, „nicht abgelegt · {Grund}“ (15 reasons), or „Ein Anhang in einem
  Ordner, den Sie nicht sehen“ (never named).
- **Row actions**: „Original (.eml)“ (a 409 `original_not_clean` replaces the
  button with „Das Original enthält Schadsoftware und kann nicht
  heruntergeladen werden“; an archive entry says „Kein Original: aus dem
  E-Mail-Archiv übernommen“; a running scan says so), „Vergleichen“ (this mail's
  Fassung against the one before, inline), ⋯ „Herauslösen …“ (only for whoever
  may file, never on the thread's only mail).
- **Herauslösen** (`detach-dialog.tsx`): „Fassung {a} bis {b} behalten diese
  E-Mail. Dieser E-Mail-Verlauf bekommt Fassung {b+1} ohne sie.“ and „Wer
  diesem E-Mail-Verlauf folgt, folgt ihm danach nicht mehr.“; the target is
  another thread or „Als neuen E-Mail-Verlauf“ (name, same folder). Refusals are
  said in the dialog (`MAIL_THREAD_REFUSALS` and a closed project).
- **Links**: `/app/projects/{id}/files?doc={threadDocumentId}&mailEntry={entryId}`
  opens the Verlauf with „E-Mails“ up and the entry scrolled to and marked (ink
  bar, `aria-current="location"`, focus moves). Closing or switching the
  preview drops `mailEntry`. A chat citation does not carry the section heading
  on the wire yet, so a citation opens the Verlauf without scrolling to its
  entry.

## Provenance (D36)

Under the preview header (the header keeps its one shape), a row for a document
whose newest Fassung came with a mail: „Kam mit der E-Mail von {Name} am
{Datum} · Domain bestätigt: {domain} · Im E-Mail-Verlauf ansehen“
(`mail-provenance-row.tsx`, from `document-version-list`'s `mailOrigins`);
several mails add „+{n} weitere“. Each Fassung row of „Fassungen und Freigabe“
that a mail brought carries the same line (`document-revisions.tsx`).

## Contrast, measured

`--warning` text measures 4.48:1 on paper and 4.2:1 inside the kit's
`Alert variant="warning"` at 12–14px, under WCAG AA. The E-Mail-Eingang draws
warnings as a gold glyph with ink words (`FactLine tone="warning"`,
`inbound-mail-atoms.tsx`) and the default Alert with a gold icon; a selected
row lifts to `bg-card` with an ink bar instead of a tint (`bg-accent/70` behind
muted 12px text is 4.33:1). The kit's warning Alert is a known AA gap of the
design system ([`grid-design-language.md`](../design/grid-design-language.md)).

## Not built yet

- „Wie vorgeschlagen ablegen“ on the Postfach row and on the push: the waiting
  row is collapsed per project, so the action needs a product call (only for a
  row of one mail, or „Alle vollständigen ablegen“), and a push action needs a
  payload version and a `notificationclick` branch.
- „Als Fortsetzung ablegen“ for a full Verlauf (`thread_full` today asks for a
  new Verlauf).

<!-- W1: append the rework's changes and its captures here from handoffs/W1-to-D17.md. -->
