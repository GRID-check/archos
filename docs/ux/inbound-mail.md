# Project mail: the E-Mail-Eingang, the E-Mails tab and provenance

**Date:** 2026-10-27
**Status:** Implemented, the W1 rework included
**Surfaces:** Dateien › E-Mail-Eingang (`/app/projects/[id]/files/mail`, `…/mail/[mailId]`), the address dialog and the settings card, the „E-Mails“ tab of a Verlauf's preview, the provenance row of a document that came by mail, the Postfach rows
**Preview:** `/dev/inbound-mail?variant=…`, `/dev/inbound-mail-detail?variant=…`, `/dev/inbound-mail-address?variant=…[&dialog=1]`, `/dev/mail-thread?variant=…`, `/dev/inbox?variant=mail`; each with `&locale=en`, and `&chrome=0` hides the variant strip. The variant lists are in each page's header.
**Why:** [ADR-0137](../adr/0137-mail-sent-to-a-project-waits-until-a-person-files-it.md); the flow: [`inbound-mail.md`](../architecture/inbound-mail.md); the words: [`CONTEXT.md`](../../CONTEXT.md#project-mail).

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

- The Dateien header: a ghost link „E-Mail-Eingang“ with a **muted** count
  pill (on the phone, the ⋯ menu entry with the count as a hint).
- A quiet line above the shelf root: „2 E-Mails warten auf Ablage · Ansehen“.
- A muted count on Dateien in the rail and the phone tab bar. The Postfach
  keeps the only ink pill.
- `ProjectMailWaiting` on the project card (`waitingMailCounts`).
- The project overview (Einstellungen › Übersicht): a full-width tile
  „E-Mail-Adresse des Projekts“, „In Cc gesetzt, bringt sie die Antworten von
  Behörde, Statik und Bauherrschaft in den E-Mail-Eingang, bereit zum
  Ablegen.“, the address with „Kopieren“, „Als Kontakt sichern“ and the footer
  link „Zum E-Mail-Eingang“. Only for whoever may decide the project's mail and
  only while an address is active; creating one stays in Einstellungen ›
  Dokumente.
- The upload menu „Per E-Mail senden …“ opens the address dialog.
- Settings › Dokumente: the address card (create, „Neue Adresse erzeugen …“,
  „Ausschalten …“; managers only).
- The Postfach rows of the seven notices (`/dev/inbox?variant=mail`).
  „E-Mails warten“ opens the list at „Bereit“ (`/files/mail#ready`,
  `lib/inbox/targets.ts`).

## The address dialog

Every door leads with what the address is for
(`features/inbound-mail/components/inbound-mail-address.tsx`). The dialog
(from „Per E-Mail senden …“ and „Adresse“) is titled „E-Mail-Adresse des
Projekts“, says „So landet die Korrespondenz im Projekt, ohne dass jemand sie
von Hand abspeichert.“, then three lines: „Setzen Sie sie in Cc, wenn Sie an
Behörde, Statik oder Bauherrschaft schreiben: die Antworten landen im
E-Mail-Eingang.“, „Leiten Sie Unterlagen aus Ihrem Mailprogramm an sie
weiter.“, „Abgelegt wird erst, was jemand bestätigt.“ Then the address with
„Kopieren“ (`CopyableValue`), „Als Kontakt sichern“ (a vCard), when mail last
arrived, how many automatic replies were dropped in 30 days, and „Anleitung“
(the help page, `/e-mail-eingang/`, `/en/project-mail/`).

The office's own DKIM line („{n} % der E-Mails Ihres Büros der letzten 30 Tage
waren von Ihrer Domain bestätigt“, or „Ihre Domain signiert ihre E-Mails nicht
– so richten Sie es ein“ linking to the help page's `#dkim`) is on the settings
card only, and only for a manager; derived from rows, never a DNS probe. The
settings card's description leads with Cc too. A member without the right to
manage sees „Bitten Sie jemanden, der das Projekt verwaltet, sie in den
Projekteinstellungen zu erzeugen.“ Rotation's confirm says that every follow on
the project ends.

The never-used list says „Noch keine E-Mails an dieses Projekt“ and „Setzen Sie
die Adresse unten in Cc, wenn Sie an Behörde, Statik oder Bauherrschaft
schreiben. Die Antworten landen hier, und abgelegt wird erst, was jemand
bestätigt.“

## The E-Mail-Eingang

**Layout by container, not viewport** (`inbound-mail-workspace.tsx`): a 22rem
list and the detail while the component's own box is wider than 48rem
(`@3xl`); below, list → detail with a back link. The filter lives on the URL
(`?status=handled`, replaced; the route and `inbound-mail-list` still take
`?outcome=`); an opened mail is pushed.

**The list** („Wartet auf Ablage · Bearbeitet“; `lib/list-sections.ts`,
`lib/completeness.ts`, `inbound-mail-list.tsx`, `inbound-mail-row.tsx`).
„Wartet auf Ablage“ has two headings: „Bereit ({n})“ first, „Braucht Sie
({n})“ second, then the collapsed quiet group „Domain nicht bestätigt oder
automatisch ({n})“ (mail from an unconfirmed domain and automatic mail).
„Bereit“ means the server's `incompleteReason` is null and the mail does not
read as an impersonation (the client refuses an impersonation on its own side
too, `fileableReason`). „Bearbeitet“ is one list: each row says its outcome.

A row: the sender's domain, the subject without `AW:`/`WG:`, the time, „· 3
Anhänge“; suggestion chips; a trust or risk glyph. Under „Bereit“: „Domain
bestätigt, für jeden Teil ein Ziel, nichts zu prüfen.“ and, with two or more
ready mails, „Alle {n} wie vorgeschlagen ablegen“ (bulk, confirmed and grouped
by destination; more than 20: „Die ersten 20 wie vorgeschlagen ablegen“, since
one request decides at most 20). A ready row outside a thread group carries
„Wie vorgeschlagen ablegen“: one press, no confirmation, the same request as
bulk and never an acknowledgement. The mail is read again first; if it changed
(„Anhang wird noch geprüft …“), nothing is filed and a toast says why. After
the press: „1 E-Mail wird wie vorgeschlagen abgelegt“ with the destinations
(„In E-Mail-Verlauf „Verfahren MA 37“: 1 · In „Behörde“: 1“). A row under
„Braucht Sie“ says what it needs: „Absender prüfen“, „Anhang prüfen“, „Anhang
wird noch geprüft …“, „E-Mail-Verlauf wählen“, „Ordner wählen“, „Projekt ist
abgeschlossen“.

Thread groups are split by readiness: a conversation's ready replies are one
group under „Bereit“ with „Alle {n} ablegen (wird Fassung {a}–{b})“ (or „Die
ersten 20 ablegen …“); its replies that need a look are a group under „Braucht
Sie“ with „Der Reihe nach ansehen“ (opens the first, with no Fassung range,
which would depend on what is filed first). The group line names the thread;
its rows do not repeat it. A row whose text a follow already appended shows no
thread line; its attachments still wait.

**Impersonation is a stop** (`riskLevel === 'impersonation'`). In the list the
row reads „Gibt sich als {Name} aus · nicht ablegen“ in red and has neither
the one-press button nor a checkbox: it can never join a bulk decision, nor by
the keyboard's X. The
detail opens with a full-width warning above the header („Vorsicht: Diese
E-Mail gibt sich als {Name} aus. …“ or „Vorsicht: Der Name {Name} gehört einem
Mitglied, die Adresse {Adresse} nicht.“, then „So beginnen Betrugsversuche mit
Kontoänderungen. …“). „Verwerfen“ is the primary button; the filing controls
fold behind „Trotzdem ablegen …“ („Nur wenn Sie telefonisch geprüft haben, dass
die E-Mail echt ist.“), and filing still needs „Ich habe geprüft, dass die
E-Mail echt ist. Trotzdem ablegen“.

**The detail** opens on the mail (`mail-header.tsx`), top to bottom:
1. The header: the subject, then ONE line „{Name} ‹{Adresse}›“ (name and
   address always together), the trust („Domain bestätigt: {domain}“ with its
   ⓘ toggletip; trust is never folded), the received time and „Details ▾“. The
   sender's flags („An andere Empfänger adressiert“, …) and „Ursprünglich von …
   · nicht geprüft“ stay visible under it. „Details“ opens Gesendet,
   Eingegangen, every recipient (An, Cc, Antwort an), „Wartet bis {Datum},
   danach läuft sie ab“ and „Original (.eml) herunterladen“ with „Öffnet sich
   im Mailprogramm; Bilder von außen werden dort geladen.“, or the original's
   infected or scanning line. In its last week the expiry comes forward into
   the header: „Wartet nur noch bis {Datum}“ (`lib/evidence.ts`,
   `EXPIRY_INLINE_DAYS = 7`).
2. The text: first lines, „Ganze E-Mail anzeigen“, „Zitierten Text anzeigen“.
   Plain text only; links are inert text with a title naming their domain.
3. The „E-Mail-Text“ row: a checkbox and the target („In E-Mail-Verlauf „…“
   ablegen (wird Fassung N)“, „Als neuen E-Mail-Verlauf ablegen“ with a name
   field). Unchecked: „Das Original der E-Mail wird nach der Ablage gelöscht“.
   When the text has content findings, the choice stands here, after the text
   and beside its filing: „Unkenntlich ablegen“ (selected), „Getrennt ablegen
   (eigener E-Mail-Verlauf)“, „Ungekürzt in den E-Mail-Verlauf“.
4. „Anhänge“: checkbox, thumbnail (clean images and PDFs only, drawn
   client-side in the sandboxed viewer; Office files show their tile), the
   name, Piloti's suggestion, and the case notes (duplicate, revision, name
   stop, macro, type mismatch, not accepted, not staged). A clean attachment
   says nothing about its scan; „Wird auf Schadsoftware geprüft …“, „Prüfung
   fehlgeschlagen, wird wiederholt“ and „Schadsoftware gefunden · lässt sich
   nicht ablegen“ still show.
5. The decision bar, pinned and safe-area padded: „Verwerfen“ left; right
   „{n} Dateien und den E-Mail-Text ablegen“ / „E-Mail-Text ablegen“ /
   „Nichts ablegen“; „Domain nicht bestätigt. Trotzdem ablegen“ only where the
   server asks for `acknowledgeSender`.
6. After filing, the follow offer: „Diesem E-Mail-Verlauf folgen“ with one line
   of what it does and the button „Folgen“, only when the sender would qualify.

On a phone (390×844) the header, the text and the first attachment fit the
first screen with the decision bar.

**Filing confirms itself** (`filed-to.tsx`, `lib/filed.ts`; the part views'
`filedAs`, per viewer like `documentId`). A filed attachment: „Abgelegt in
{Ordner} · Fassung {N} · Öffnen“ (root: „Dateien (oberste Ebene)“), its row
showing the name it was filed under. A filed text: „In E-Mail-Verlauf „{Name}“
abgelegt · Fassung {N} · Öffnen“; by a follow „Dem E-Mail-Verlauf „{Name}“
angefügt (Verlauf folgen) · Fassung {N}“. Where the viewer may not read the
folder: „In Dateien abgelegt“ / „In einem E-Mail-Verlauf abgelegt“, never the
place. One toast after a filing in the detail („1 Datei und der E-Mail-Text
abgelegt“, „N Dateien abgelegt“, „E-Mail-Text abgelegt“) with a line per part
(„E-Mail-Text → „Stellplatznachweis“ · Fassung 4“, „Bescheid_MA37….pdf →
Behörde/Bescheide · Fassung 1“) and „Ansehen“. A filing has no undo;
„Öffnen“ and „Ansehen“ are the way on. A mail of which something was filed and
one part dismissed says „1 Teil verworfen · wiederherstellbar bis …“ instead
of a page-wide „Verworfen · …“.

**Piloti's mark** (✦) appears on a folder chip only when the folder is Piloti's
stored suggestion; the rule's default folder for a new Verlauf is a plain chip.

**Bulk** by selection: „{n} ausgewählt · Wie vorgeschlagen ablegen ·
Verwerfen“, enabled only when every selected mail is complete
(`incompleteReason === null`); it never carries an acknowledgement and confirms
with a dialog grouped by destination.

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
- **Follow control** (`follow-control.tsx`): following, „Sie folgen diesem E-Mail-Verlauf
  bis {Datum}“ with „Verlängern“ (only while the follow can grow at least a day
  within 180 days of its start; otherwise „Folgen gilt höchstens 180 Tage ab
  Beginn. Danach erneut folgen.“) and „Nicht mehr folgen“. Not following: a
  card titled „Diesem E-Mail-Verlauf folgen“, one line of what it does and the
  button „Folgen“; toast „Sie folgen
  „X“ bis {Datum}“ with „Rückgängig“. Others: a count („2 weitere Personen
  folgen“); for a viewer with `managesFollows`, „Wer folgt“ by name with
  „Beenden“ each.
- **One row per mail, newest first** (`mail-thread-entry.tsx`): the heading
  exactly as the document cites it; „ab Fassung N · eingegangen {Zeit}“; trust
  in three words: „Domain bestätigt: {domain}“ once per run of consecutive
  mails from the same confirmed domain, on the newest (`entriesSayingTrust`);
  „Domain nicht bestätigt“ with the warning glyph and „Aus dem E-Mail-Archiv ·
  nicht geprüft“ on every mail. The heading wraps between date, name and
  domain, never inside the date, and is still exactly what the document
  prints; „ab Fassung N“ and „eingegangen …“ wrap as two units. Preview:
  `/dev/mail-thread?variant=same-sender`; how it was
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

## Following ends with the project

Closing a project ends every running follow of its E-Mail-Verläufe, as the
manager who closed it, reason `project_closed` („Das Projekt wurde
abgeschlossen“; `endFollowsOnProjectClose` in `lib/mail-thread/follows.ts`,
called from `lib/projects/service.ts`). Mail that still arrives waits for a
person as before. Reopening starts no follow again: following is the
follower's own act. Sweep 12 also ends, as the system, a follow it finds
running in a closed project, so a close whose follow-ending failed is caught
on the next sweep.
