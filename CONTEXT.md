# Piloti

Piloti is the workspace for architects: an Austrian planning office runs its
work in it, every project and every process, and Piloti, the agent, is a
colleague in that office who does part of the work, with a source for every
claim. Building law is one of the things it knows, not the frame around it
([`VISION.md`](VISION.md)). This file is its domain language: what the words mean, in the product and
in conversation about it. The engineering vocabulary (tenancy helpers, CI,
deploys, tooling) is in [`docs/glossary.md`](docs/glossary.md).

Product copy is German, so many terms are German. The English gloss follows the
term, and the English word is the canonical one for anything an agent reads:
an operation's name and description, a tool's text, a refusal (AGENTS.md,
"Industry standard first"). The German word is what a person reads, through
i18n; the English word is what an agent reads and what the code says. Until
October 2026 the German word was canonical everywhere, and agents read German
descriptions and refusals; every agent client then paid a translation, and one
concept had two or three names. The agent's words and their standard
equivalents are in
[`docs/glossary.md`](docs/glossary.md#agent-surface-and-standard-terms).

## The office and its work

**Piloti**:
The product, and the colleague persona that works in it. The name users see.
_Avoid_: GRID in anything a user reads; GRID is the repository's and the code's name.

**Organization** (Büro):
A planning office, and the boundary nothing crosses: its documents, memory,
projects and members are never visible to another organization.
_Avoid_: tenant, in product copy.

**Project** (Projekt):
One building project inside an organization, with its own documents, intake
facts and members, who are a subset of the organization's people.

**Steckbrief** (project record):
The project's profile page: its facts (federal state, building class, plot,
planned work) and the people on it, kept apart from them (ADR-0091, ADR-0101).
_Code_: `projectRecord` (`lib/projects/project-record-*`, `ProjectRecordView`);
the Bundesland is `federalState`, the Gebäudeklasse `buildingClass`.

**Aktiv / Ruhend / Abgeschlossen** (active / paused / closed):
The three states of a project's lifecycle, moved between only on purpose: a
paused project is waiting and will go on, a closed one is over and has become
the office's reference, read-only and readable by everyone in it.
_Avoid_: archived, finished or done for a closed project; "inactive" for a paused one.

**Abschluss** (completion):
The month a project's work ended, named when it is closed, never a field of a
running project. A closed project is **fertiggestellt** (completed) or **nicht
realisiert** (not realized).
_Avoid_: end date, as if it were a plan.

**Platform**:
The operator level above every organization, which sets the defaults each
organization inherits unless it overrides them.

**Entwurfsverfasser** (design author):
The planner of record who signs the submission. Piloti supports this person and
never replaces them.

**Behörde** (building authority):
The authority that decides on a submission and issues the Bescheid. Piloti does
not stand in for it.

**Wert / Schätzung / noch offen** (value / estimate / still open):
The three answer modes of a project intake question. A Wert becomes a fact, a
Schätzung an unconfirmed assumption, and noch offen an open question Piloti asks
about when an answer depends on it.

**Projekterfassung** (project setup from the documents):
The way into a new project where Piloti reads the project's documents, suggests
each value with the page it was found on (*Vorschlag*), and asks only the
*Rückfragen* whose answer would change the Gebäudeklasse; a person confirms.
The *Einrichtung* (the wizard) is the other way into the same profile. A value
two documents state differently is a *Widerspruch*, shown, never decided by
Piloti. A project created as abgeschlossen is set up the same way and closed
when its Erfassung is finished.
_Avoid_: wizard, for the Projekterfassung; „Plan" for any of the documents it reads.

**Gebäudeklasse** (building class):
The OIB classification of a building that many requirements depend on. Piloti
asks for it when an answer turns on it.

## Sources

**OIB-Richtlinie** (OIB guideline):
One of the Austrian Institute of Construction Engineering's technical
guidelines (Richtlinie 1 to 6, with 2.1 to 2.3), the binding text most answers
rest on.

**Punkt** (point):
A numbered clause of an OIB-Richtlinie, and the unit Piloti cites ("OIB 2 Pkt.
3.5.2").

**RIS** (Rechtsinformationssystem):
The Austrian federal legal information system, the source for exact pointers
into laws and ordinances.

**Source kind**:
The coarse family every source belongs to, which decides how it is shown:
*Baurecht & Richtlinien* (building law and guidelines), *Büroarchiv* (the
office's own standards, details and experience), *Projektwissen* (this project's
documents, Bescheide and uploads) and *Web*. A *Modellmessung* (a value measured off
the project's BIM model) is shown beside them but is never a source for a legal
verdict.

**Shelf**:
Where a document lives, which decides who may read it and what a search reaches:
the *Büroablage* (the organization's shelf, formerly „Archiv"; code name
`officeShelf`, never `archive`, which already means soft-archived), a project, a single chat, or the shared OIB base every organization
sees. The Büroablage can hold norms an office uploaded itself (ÖNORMEN,
Weisungen) that the OIB base does not carry.
_Code_: `officeShelf` in identifiers, file names and modules (`lib/office-shelf`,
`OfficeShelfWorkspace`, `canManageOfficeShelf`). Stored and public forms are
`office_shelf` (scope value, wire value), `/app/office-shelf` and
`/api/office-shelf`, and the permission `org:office_shelf:manage`. Still `archiv`,
read beside the new name until an operator moves them
([runbook](docs/deployment/office-shelf-rename-runbook.md)): the collection
prefix `archiv_<org>`, the old permission slug, and the history of audit rows.
_Avoid_: folder; folders organise documents within a shelf, a shelf decides who sees them.

**Dokumentart** (document type):
What a document is (an OIB-Richtlinie, a law, a standard, a Grundriss, a
Gutachten…), set by a person and always trusted over a guess from the file name.
*Korrespondenz* (correspondence) is a letter or e-mail exchanged between
parties; a filed **E-Mail-Verlauf** is one. „E-Mail“ is the format (the lane
„Projektwissen · E-Mail“), *Korrespondenz* the type. A Bescheid that arrived by
e-mail is a copy („Kopie per E-Mail“), not its Zustellung, and Fristen run from
the Zustellung.
_Code_: the type token `correspondence`.

**Fassung** (revision):
One state of a document, whether it was uploaded again under the same name or
filed under another name and linked: both are Fassungen in one timeline,
numbered „Fassung 3 von 5“ (“Revision 3 of 5”). A later Fassung replaces an
earlier one, and the earlier one stays readable on request. Offices mark it in
the file name with an index or a date (*Stand*, always a date or an index:
„Stand vom 14.08.2026“); Piloti reads that as a suggestion a person confirms.
_Avoid_: Plan, Planstand, for any file. A name with an index says a file has
Fassungen, not that it is a drawing; only its Dokumentart says what it is. Say
Dokument, Datei, Fassung or Stand. Also avoid „Version“ and “version” where a
reader sees it, „Upload 3“ as the name of a Fassung, and „Stand“ for a state.
_Code_: `revision`. The links between the Fassungen of one document are
`RevisionLinks` (`lib/documents/revision-links.ts`); `RevisionFacts` is the
Index and Rev read off a title block, a different thing. The routes are
`/api/documents/{id}/revision`, `…/revision-compare` and `…/revision-candidates`
(the `fassung` paths redirect for one release), and the listing property is `revision`.

**Freigabe** (approval):
The office approving one Fassung, and only that. Its status (*Freigabestatus*)
has eight words: Entwurf, In Prüfung, Änderungen angefordert, Freigegeben,
Veröffentlicht, Ersetzt, Abgelehnt, Stillgelegt (Draft, In review, Changes
requested, Approved, Published, Replaced, Rejected, Retired). Approval asserts
the content; Piloti answers only from a *veröffentlicht* Fassung (ADR-0054), so
say „Piloti antwortet aus dieser Fassung“, never „Grundlage für Antworten“.
_Avoid_: „freigeben“ for a held upload (see **Zurückgehalten**) or for sharing
(see **Share**); „Änderungen erbeten“; “Superseded”.

**Anmerkung** (annotation):
A mark someone sets on one page of one Fassung: a point or a drawn box (*Bereich*)
with what it says, a running number („Nummer 4“, what a Jour fixe and a
Protokoll name), optionally a person responsible (*Zuständige*, someone who
may change the document, because they answer the mark and close it) and a
date (its *Frist*, of which the Zuständige is reminded when it is near and
when it has passed), and a thread of answers. It is *offen*, *erledigt* or *verworfen*.
An open mark that still holds on a new Fassung is carried over to it
(*auf die aktuelle Fassung übernehmen*), at its place, with its number and its
thread; when another document replaces its own, it goes on there as a linked
mark, and the old one is closed with the link. Piloti's own findings are
*Vorschläge* until a person takes them over (*übernehmen*); only then are they
the office's. A mark the person asked Piloti to set is open at once, in that
person's name, and when asked Piloti changes or deletes marks as the person
could, leaving a short note in the mark's thread. Marks are set and discussed
in the *Prüfansicht*, the document opened full screen, together and live.
A person can hand an open mark to Piloti (*an Piloti delegieren*): the mark
keeps its *Zuständige*, and Piloti works it on behalf of the person who
delegated („Piloti arbeitet daran · für Miriam“) and hands it back when that
turn has ended, whatever its outcome, or when Piloti could not start on it at
all; taking it back stops Piloti. An answer in
the thread that names Piloti (@Piloti), or answers Piloti's own open Rückfrage,
*weckt* Piloti: it answers there even when nobody has the chat open (ADR-0106).
Each change Piloti makes to a mark is recorded with its turn and can be undone
while nobody has changed it since, including a mark it set for you and a reply
it wrote for you, as long as nobody else has answered in that thread.
_Avoid_: ticket, issue, Mangel for every mark (a Mangel is one *Art*); comment,
for the mark itself rather than an answer in its thread; „Piloti zuweisen“:
work is assigned to people and delegated to Piloti.

**Zurückgehalten** (held back):
An upload the content check (*Inhaltsprüfung*) keeps from every model until
someone with the right *prüft* it and lets it through (*zulassen*, “allow”) or
deletes it (ADR-0086). It waits in the *Quarantäne*: „zurückgehalten“ is the
state, the Quarantäne the place.
_Avoid_: „freigeben“, “release”: both collide with **Freigabe**; „zurückgehalten“
for a file the **Namensprüfung** stopped, or for a mail waiting in the
**E-Mail-Eingang**.

**Namensprüfung** (name check):
The check of a file's name and its folders' names against the office's list,
before the upload (ADR-0086): in the browser, before any byte or name leaves;
repeated by the server, and by the e-mail import. When a mail arrives at a
project's address, a match is shown on the attachment (and on a new
E-Mail-Verlauf's name) and the person deciding may file it anyway
(*Trotzdem ablegen*). What it stops is *Nicht
hochgeladen* (“Not uploaded”), and nothing of it is stored; the upload summary
counts it by term, never by name. The uploader may upload one file anyway
(*Trotzdem hochladen*, “Upload anyway”), their own call, which the audit trail
records.
_Avoid_: „zurückgehalten“, „Quarantäne“ (the *Inhaltsprüfung*'s, see
**Zurückgehalten**), „ausgeschlossen“, „Namensfilter“, „bleibt auf Ihrem
Rechner“ as the state's name.

**Piloti-Dokument**:
A document Piloti wrote and a person approved and published, which then counts
as office knowledge. Its *Herkunft* (origin) names who wrote and who approved it.

**Fundstelle** (locus):
The exact place a statement is pinned to: a Punkt, a section, a page.

## Project mail

**E-Mail-Eingang** (Project mail):
Where mail sent to a project's e-mail address waits until a person files it
(ADR-0134). Each part of a mail, its own text and each attachment, is
*abgelegt* (into a folder the person chooses, under a name and a Dokumentart,
possibly as a new Fassung; the text usually into its **E-Mail-Verlauf**) or
not; a mail nobody wants is *verworfen*, and one nobody decides *läuft ab*
after 30 days; both can be *wiederhergestellt* for seven days. Until a person
files it, nothing of a mail is a document: nothing indexes it and no model of
Piloti's reads it. Anyone may write to the address; each mail says whether its
sender's domain was confirmed („Domain bestätigt: …“, „Domain nicht
bestätigt“), which shapes what is suggested and never files anything by itself.
A mail that poses as a member („Gibt sich als … aus“) is a stop, never a
default. Attachments are checked for malware before anyone can file them. Who
may add documents to the project decides; the folder's write right still
applies to where a file goes. The list's filter is „Wartet auf Ablage ·
Bearbeitet“ (Abgelegt, Verworfen, Abgelaufen).
_Avoid_: Postfach (the notifications), Posteingang (Outlook's folder), Inbox,
Intake; „annehmen“, „ablehnen“, „freigeben“, „zulassen“, „prüfen“ (**Freigabe**
and **Zurückgehalten** own those); „übernehmen“ for a mail; „anhängen“ (collides
with Anhänge); „Abgelegt“ as a mail's state; Quarantäne; „Nachricht“ for an
e-mail („3 neue E-Mails“); „Absender bestätigt“ (DKIM proves a domain, not a
person).
_Code_: `inbound mail` (`lib/inbound-mail`, `inbound_mails`, operations
`inbound-mail-*`, route `files/mail`); the verbs `file`, `dismiss`, `restore`;
the states `waiting`, `settled`, `filed`, `dismissed`, `expired`; never
`inbox` or `intake`.

**E-Mail-Adresse des Projekts** (project mail address):
The address `<name>.<token>@piloti.at` a project receives mail at. Whoever
knows it can put mail in front of the office, never into the project. A leaked
address is replaced (*neue Adresse erzeugen*): the old one stops working at
once, and every *Folgen* on the project ends.
_Avoid_: Projektadresse, which is where the building stands.
_Code_: `inbound mail address` (`inbound_mail_addresses`,
`inbound-mail-address-*`, verb `rotate`).

**E-Mail-Verlauf** (mail thread):
One e-mail conversation filed as one document of Dokumentart *Korrespondenz*:
each filed e-mail is a section, and each one filed later adds a Fassung, so
the newest Fassung holds the whole conversation and Piloti cites one e-mail of
it. E-mails from the project's address and from an imported Outlook archive
end up in the same E-Mail-Verlauf, each once. Each section keeps its *Original
(.eml)* as evidence: downloadable by whoever may read the Verlauf, never read by
a model. An e-mail filed into the wrong Verlauf is *herausgelöst* (moved to
another or a new one; the earlier Fassungen keep it). Its tab in the preview is
„E-Mails“.
_Avoid_: bare „Verlauf“ (the chat's), Thread, Unterhaltung, Version,
„Nachrichten“ for its tab.
_Code_: `mail thread` (`lib/mail-thread`, `mail_threads`, `mail_thread_entries`
for its e-mails, verb `detach`).

**Verlauf folgen** (follow a mail thread):
A person's standing, revocable decision about one **E-Mail-Verlauf** („Diesem
E-Mail-Verlauf folgen“, „Sie folgen diesem E-Mail-Verlauf bis …“, „nicht mehr
folgen“): while it runs (60 days, renewable up to 180), the text of later
replies from confirmed domains already in the conversation is added without a
click, in that person's name; attachments still wait in the
**E-Mail-Eingang**. It ends when the person or a manager ends it, when it runs
out, when the person loses access, when the address is replaced, or when an
e-mail is herausgelöst from that Verlauf.
_Avoid_: abonnieren, automatisch ablegen.
_Code_: `follow` / `unfollow` (`mail_thread_follows`, `mail-thread-follow`).

**Original (.eml)** (original):
The e-mail exactly as it arrived, kept as evidence beside its section: never a
document, never indexed, never read by a model, scanned for malware on every
download.
_Avoid_: Rohdaten, Quelltext.
_Code_: `original` (`_mail-originals/`, the operations `*-original-get`).

**E-Mail-Import** (mail import):
A person's own Outlook archive (.pst/.ost) filed into a project as that person
(ADR-0085): attachments into one folder per e-mail, the e-mails' text into the
project's E-Mail-Verläufe, skipping any e-mail the project already has.
Starting it is the person's decision, so it does not wait in the
E-Mail-Eingang.
_Code_: `mail import` (`lib/mail-import`, `mail_imports`).

**Postfach** (inbox):
Where a person's notifications wait: requests, notices, warnings. Not a
mailbox; no e-mail is in it.
_Avoid_: Posteingang, E-Mail-Eingang.
_Code_: `inbox`.

## An answer

**Turn**:
One question and everything Piloti does to answer it, from the first step to the
settled answer.

**Herleitung** (derivation):
The visible trace of a turn above its answer: what Piloti searched, what it
found, where it checked.
_Code_: `derivation`.

**Belegt durch** (backed by):
The row of source chips under an answer, one per document that backs its claims.

**Citation**:
A pointer from a claim to a document and a place in it. It must resolve to a
passage the turn read, and a § or Punkt written beside it must stand in that
passage. A pointer that does not hold is not removed silently: it is replaced
by *Beleg nicht verifiziert* (citation not verified) where it stood. A quote
that does not match the source word for word, or changes what it negates
(*nicht*, *kein*, *nur*, *außer*), is marked *nicht wörtlich in der Quelle
belegt* (not verbatim in the source) and lowers the answer's confidence.

**Provenance class** (Belegart):
Where one sentence of an answer comes from: *quoted* or *cited* (a passage),
*record* (an object in the workspace, read this turn), *action* (a proposal this
turn filed), *measured* (the building model), *reasoning* (an Einschätzung drawn
from a cited sentence), *model knowledge* (nothing in the answer behind it), or
*cited, not verified*. Every sentence shows where it comes from.
_Code_: `claim_provenance`, `claim_stamps`.

**Confidence** (Sicherheit):
How far an answer can be relied on: high, medium or low. It is held to the
weakest sentence the answer rests on (every statement about the law, a value
or a deadline). A statement about the law needs a cited passage; a record or a
measurement backs a fact about the office or the building, never the law.

**Answer kind**:
The shape of an answer: *direct*, *walkthrough*, *ruling* or *handoff*. Only a
ruling has a verdict.

**Verdict** (Urteil):
The short, copyable result of a ruling, at the head of the answer.

**Takeaways** (Kernaussagen):
Two to five key points, earned only by a long answer.

**Callout** (Hinweis, Achtung, Frist, Tipp):
The one highlighted note an answer may carry: a remark, a warning, a deadline or
a tip.

**Card**:
A structured piece of an answer drawn as its own element (a table of values, a
document, a proposal to confirm) because prose cannot carry it. An *interactive
card* asks the reader for a decision that cannot be taken back.

**Repair**:
The correction of a misquoted passage after the answer has settled, in place,
without adding or removing a source.

**Follow-ups**:
Suggested next questions offered after an answer, produced after it is
delivered and never holding it up.

**Memory** and **knowledge**:
Memory is the briefing Piloti carries into every turn (what the office and the
project have told it). Knowledge is the library it searches on demand.

## Research

**Shallow research**:
The ordinary answer to a chat question, researched and cited within the turn.

**Deep research** (Tiefenrecherche):
A commissioned research run that works through many documents in the background
and delivers a report with findings, not a chat answer. Piloti proposes it, with
a reason, when a question needs it.

**Rechercheplan** (research plan):
What a deep research run will do and which documents it will read, shown for
approval before it starts.

**Grundlage / Ausgeschlossen / Rahmen** (basis / excluded / frame):
How a research plan treats documents: a Grundlage is read in full, an
Ausgeschlossen document is never used, and the Rahmen is which kinds of source
the run may draw on at all.

**Befund** (finding):
One requirement checked: *erfüllt* (met), *nicht erfüllt* (not met), *offen*
(open) or *nicht anwendbar* (not applicable), with its Fundstelle. The
*Befundmatrix* is the table of all of a report's findings.
_Code_: `finding`, `findingsMatrix`; the four results are `met`, `notMet`, `open`
and `notApplicable` in identifiers.

**Abdeckung** (coverage):
Whether the sources a search found answer the question. *Abdeckung:
unzureichend* says they do not, without hiding what was found.

## Delegated work

**Aufgabe** (task):
Work handed to Piloti to carry out, such as a *Soll-Ist* check (target against
actual), an *Einreichcheck* (submission check), a document or a revision. A
*stehende Aufgabe* (standing task) runs on a *Zeitplan* (schedule); a one-off
runs once, at a due time or by hand. Agents read "task" (the task definition).
_Avoid_: Auftrag, for this or for a run (the word stays only for a client's
commission to the office); job, which is a claim-queue item in the code and
nothing a person or an agent reads.

**Lauf** (task run):
One attempt at an Aufgabe, or one commissioned deep research: a single message
in the thread that asked for it. Agents read "task run".
_Avoid_: Auftrag; "Aufgabe" for one attempt; job.

**Laufblock** (run block):
The element in the thread that shows a run: *angelegt* (created), *läuft*
(running), *wartet* (waiting), *fertig* (done), *fehlgeschlagen* (failed),
*abgebrochen* (cancelled) or *unterbrochen* (stopped early, with a report from
what was there).
_Code_: `RunBlock`; the states are `running`, `waiting`, `done`, `cancelled` and
`interrupted`.

**Chat** (conversation):
A thread with Piloti and the people in it, in a project, in the office or on
its own. Agents read "conversation".
_Avoid_: Unterhaltung, Gespräch.

**Zuständig** (assignee):
The person an Anmerkung or a document is assigned to, who answers it. Agents
read "assignee".
_Avoid_: Verantwortlich.
**Anfrage eines Agenten** (ask):
A question an agent the person connected (Claude, Cursor, an A2A agent) puts
to Piloti on their behalf. Piloti answers it like a typed question, as that
person and on their budget, in a private conversation of theirs.
In the A2A protocol an ask is a *task*, its conversation the *context*, and
its answer an *artifact*; that is the protocol's word, not an Aufgabe.
_Avoid_: task, Aufgabe or job for an ask, outside the A2A wire.
_Code_: `piloti_asks`; the states are A2A's: `submitted`, `working`,
`completed`, `canceled`, `failed`, `rejected`.

## Sharing and keeping

**Share** (Teilen):
Access to one resource (a project, a chat, a document) granted to a person, as
*viewer*, *collaborator* or *owner*.
_Avoid_: Freigabe, which is the approval of a Fassung.

**Spectator**:
Someone watching a shared turn live without taking part in it.

**Soft delete**:
Deletion that waits out a grace period, during which the item can be restored:
seven days for a project, fourteen for an organization, none for a document or a
chat.

**Legal hold**:
A hold that keeps deleted data from being purged, for as long as it is active.
