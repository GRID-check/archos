---
status: proposed
date: 2026-10-27
decision-makers: product owner, Grid engineering
consulted: the security, shippability and product red teams of the project-mail design
informed: everyone who builds on documents, the agent door, retention or the inbox
---

# Mail sent to a project waits until a person files it; a conversation is one document; its originals are evidence; a person may follow it

## Context and Problem Statement

A planning office's correspondence about a project lives in Outlook: the
Behörde's letter with the Bescheid attached, the Statiker's reply with the next
Fassung of S-101, the Bauherr's project manager answering all. Until now it
reached Piloti only when somebody saved an attachment by hand, or imported a
whole Outlook archive afterwards (ADR-0085). The workspace did not have the
conversation itself, so Piloti could not say what the Behörde wrote, and a file
that came by mail had no record of the mail it came with.

Giving every project an address (`<slug>.<token>@piloti.at`, the transport is
ADR-0138) fixes the gap and opens a new one: anyone who knows the address can
put bytes and words in front of the office. A conversation where the project
is only in Cc grows through other people's replies, so the address cannot be
limited to members. And a mail is third-party text: an injected instruction, a
forged sender, a malware attachment, a payment-change fraud dressed as a
colleague.

The question this record answers: what happens to a mail between its arrival
and its becoming part of the project, what it becomes, and who may decide.

## Decision Drivers

* **Nothing enters a project without a person's decision.** The owner's words:
  "nothing is filed without a person's decision, for that mail or as their
  standing decision to follow the conversation". It must hold for every code
  path, and the database must say who decided.
* **No model Piloti runs reads a held mail.** Before a person filed it, a
  mail's text and bytes are a stranger's; prompt injection and data the office
  never chose stay out of every model.
* **The mail is the asset.** A conversation is what an office cites, disputes
  and hands to a lawyer. Its text, its order and its original bytes matter, not
  only its attachments.
* **One shape for mail, whichever way it arrives.** Mail to the address and
  mail from an imported archive end in the same conversations, each once.
* **Review must not become a second inbox.** 10 to 50 mails a day per project
  are realistic; filing the common case is one press, and a followed
  conversation's replies need no press at all.
* **Authentication shapes defaults, never acceptance.** DKIM proves a domain,
  not a person. A verdict decides what is suggested and pre-selected, never
  whether a mail is held.
* **Strangers' bytes are checked before anyone acts on them**, in the cluster
  (ADR-0136).

## Considered Options

**Where a held mail lives**

1. As a document in the Quarantäne (ADR-0086), released by an admin.
2. As a Fassung in Freigabe (ADR-0054), approved by a reviewer.
3. As a Piloti proposal (ADR-0105) the person accepts or dismisses.
4. As its own review object outside the project's documents, decided part by
   part by whoever may add documents to the project.

**What a filed message becomes**

1. One document per message (the archive's note of ADR-0085 §7).
2. One document per conversation, each message a section, each later message a
   new Fassung.
3. Both.

**What happens to the original `.eml`**

1. Erased when the mail settles (this design's first version).
2. Kept as evidence beside its section: never a document, never read by a model.
3. Kept as a document of its own.

**Whether a mail can be filed without a click**

1. Never.
2. Per sender: a verified member's mail files itself (the unmerged PR #831).
3. Per conversation: a person's standing, revocable decision to follow one
   E-Mail-Verlauf, under strict conditions, for the text only.

## Decision Outcome

Chosen: **a held mail is its own review object (4); a conversation is one
document with one Fassung per filed message (2); the original is kept as
evidence (2); a person may follow a conversation (3)**. Each rejected home is
reused for what it does well: the content check after filing (Quarantäne),
card mechanics for Piloti (proposals), decision scoring (Freigabe's scores).

### The guarantee

No server path files received mail on its own. Every filed part references a
decision row made by a named person, either on that mail or as that person's
standing, revocable decision to follow its conversation, which appends text
only, only from verified senders whose thread headers are signed. Piloti's
part is a card that person accepted, and it carries no override. The database
refuses a filed part without such a decision and without a clean scan.

What enforces each half is under Confirmation; the CHECKs and triggers are in
[`schema.md`](../database/schema.md#project-mail-migration-0186-adr-0137).

### The E-Mail-Eingang: a mail waits outside the project

A mail that arrives is held (`inbound_mails`, `status = 'waiting'`), with one
part per thing a person can file: its own text (`kind = 'message'`) and each
attachment (`kind = 'attachment'`). While it waits it has no `documents` row,
so no listing, search, export, retrieval or agent read can reach it by mistake,
and it takes no name in the project. The place is the project's
**E-Mail-Eingang**, inside Dateien (`/app/projects/[id]/files/mail`).

The receive job (`lib/inbound-mail/receive-job.ts`) runs as the system and can
file nothing. It scans the whole raw message before the mail becomes `waiting`
(a CHECK), drops auto-replies, delivery reports and loops, authenticates the
sender, reads the MIME tree, runs the Namensprüfung on each attachment's name
and the subject, scans each attachment, asks the Python reader for the text
(`POST /v1/mail/read`, no model), redacts every other project's address,
matches the project's threads, stages the parts and holds the mail. The flow,
step by step: [`inbound-mail.md`](../architecture/inbound-mail.md).

**Who sees and decides.** Holders of `project:documents:write` on the project
(org admins through the usual bypass) see the E-Mail-Eingang and decide, behind
the office's `inbound-mail` WorkOS entitlement. A part goes into a folder only
with `requireFolderWrite` on it, checked when the person decides and again by
the upload path in the job. Thread candidates, possible earlier Fassungen and
duplicates are computed for the viewer at read time and filtered by what that
viewer may read; the stored rows hold ids only, so a writer never learns a
restricted folder's names from a mail.

**What a decision is.** `POST /api/projects/[id]/inbound-mails/file` decides up
to 20 mails; each listed part is filed, every other waiting part of that mail
is dismissed. The person names, per part, the folder (or a path to create), the
name, the Dokumentart and optionally `revisionOf`; for the text, the thread to
append to or a new one. Acknowledgements (`acknowledgeSender`,
`acknowledgeRisk`, a name release) are accepted only in a request about one
mail, so a bulk action never carries one. The decision rows are appended in one
transaction with a compare-and-set claim of each part; the filing job reads
what to do from those rows and nowhere else.

**„Bereit“ is the list's surface of `incompleteReason`** (RT-X10). The waiting
list shows the mails whose `incompleteReason` is null and that do not read as
an impersonation under „Bereit“, the rest under „Braucht Sie“, each saying what
it needs. A ready row's one-press „Wie vorgeschlagen ablegen“ sends the same
request, under the same rule, as the bulk action: no acknowledgement, at most
20 mails. The Postfach's „E-Mails warten“ row links to „Bereit“ rather than
carrying the action: it is one row per project and carries no mail's state, so
it cannot honestly say which mail one press would file. Each part view carries
`filedAs` (name, folder, Fassung) once filed, resolved per viewer like
`documentId`, so the person sees where every part went.

**Filing is the ordinary upload, as the person.** The filing job
(`inbound_mail_file`) runs in the decider's own session and files through the
upload path: Namensprüfung, Inhaltsprüfung, the office's accepted file types,
quota and folder rights apply unchanged. It files a mail's attachments first
and its text after them, so the text's entry records what became of each
attachment. Filing a person's upload publishes it with the person as approver
(ADR-0054); so does filing a mail. The preview shows the provenance beside the
Freigabe rail: who filed it, and which mail it came with.

**Sender trust is a label.** Every mail carries `sender_trust`
(`member_verified`, `member_unverified`, `external_verified`,
`external_unverified`) and flags (`not_addressed_to_project`, `bcc_own`,
`stale_date`, `date_out_of_range`, `message_id_reused`, `already_filed`,
`claims_member_name`). *Verified* is an aligned DKIM pass with the hygiene
rules of `lib/inbound-mail/sender-auth.ts` (no `l=`, no `t=y`, not expired,
From, Subject, Message-ID and Date signed, one ASCII From). *Member* is an exact
address match against the directory; a display name never makes a member. The
label decides:

- what is pre-selected: a thread append or a new Fassung only for a
  `reference` or `thread_index` match of a `member_verified` mail, or of an
  `external_verified` one whose matching header is signed, and never under
  `not_addressed_to_project` (except a member's own Bcc copy), `stale_date`
  or `date_out_of_range`;
- what needs an acknowledgement: an unverified member address, a failed or
  rejected signature, a verified mail not addressed to the project (outside the
  Bcc case) and a stale date need `acknowledgeSender`; an append or Fassung the
  defaults would not pre-select needs the part in `acknowledgeRisk`
  (`unverified_thread`), as do `macro` and `type_mismatch` attachments;
- whether Piloti suggests anything (not for `external_unverified`, automatic or
  impersonating mail);
- how the Verlauf cites it: a verified section is headed by the signer's
  domain, an unverified one says „Domain nicht bestätigt“.

A mail that poses as someone (a rejected signature, or an outsider's display
name that is a member's: `claims_member_name`) is an **impersonation**: no
suggestion, nothing pre-selected, never part of a bulk decision, and the detail
opens behind a warning with „Verwerfen“ as the primary action
(`lib/inbound-mail/sender-risk.ts`).

**The name check flags, it does not drop.** A Namensprüfung match on an
attachment's name is `name_stop`; the part is unselected and needs
`screeningRelease: 'name'`, audited as an override (ADR-0086, amendment of
2026-10-27). The Verlauf's name and a new folder path are screened when the
person decides.

**A finding in the text is decided before filing.** The content check runs on
the own text after the signature is removed. With a finding, the person
chooses „Unkenntlich ablegen“ (the default: the spans are masked in the
Verlauf, the original keeps the bytes), „Als eigenen E-Mail-Verlauf ablegen“,
or „Ungekürzt in den E-Mail-Verlauf“, which holds the whole Verlauf until
someone checks it (ADR-0086).

### The E-Mail-Verlauf: one document per conversation

A filed message becomes an entry (`mail_thread_entries`) of a thread
(`mail_threads`), and the thread's document is the **E-Mail-Verlauf**: a
Markdown rendition with one `##` section per message, ordered by the clamped
send time, Dokumentart *Korrespondenz* (token `correspondence`), lane
„Projektwissen · E-Mail“. Each later message filed into the conversation adds
a Fassung, and **Fassung N+1 holds every section of Fassung N byte for byte**
(the superset invariant; `lib/mail-thread/render.ts` is a pure function over
the entries, golden-tested). Retrieval serves the current Fassung (ADR-0054),
so Piloti sees the conversation once and cites one message by its section.

- **Headings never change**, so citations hold: `{dd.mm.yyyy HH:MM} · {name}
  ({signer domain})` for a verified mail, `… ({from domain}, Domain nicht
  bestätigt)` for an unverified one, `… ({from domain}, aus dem Outlook-Archiv)`
  for an archive entry. A quoted block becomes „Zitat in der Nachricht von …“,
  never the quoted party's words, and is folded only where it repeats an entry
  the thread already holds.
- **Each section says when it arrived** („eingegangen …“, `received_at`). The
  send time is believed only within `[received − 30 days, received]`; a Date up
  to 15 minutes after receipt is a fast clock and is put at the receipt without
  a flag, anything further out is the receipt with `date_out_of_range`.
- **A Bescheid that came by mail is a copy.** Fristen run from the
  Zustellung, which a mail does not establish; the Verlauf and the guide say
  „Kopie per E-Mail“. Reading a Frist out of a message is a follow-up (FU4).
- **Matching** is a ladder per project (`lib/mail-thread/mail-threading.ts`):
  `reference` (References or In-Reply-To names a message the thread received,
  with an equal base subject), `thread_index` (Outlook's GUID and an equal
  subject), `reference_subject_changed`, `subject` (an equal base subject and a
  shared participant within 60 days). Only the first two are ever
  pre-selected.
- **Caps**: 200 entries or 2 MiB per thread; past them an append is refused
  (`thread_full`) and the person files the text as a new Verlauf. The schema
  has a `continues_thread_id` link for „Als Fortsetzung ablegen“; no code
  writes it yet.
- **The thread's language is fixed** at its creation (`mail_threads.locale`),
  because Fassung N+1 repeats every word of Fassung N.
- **One writer at a time.** Every writer of a Fassung (a filing, a follow, a
  detach, an archive render) takes the thread's render lease
  (`render_lease_holder`, `render_lease_until`) with a compare-and-set, renders
  and uploads under it, and lets it go. A transaction cannot hold that
  serialization: the upload is object storage and HTTP, and a pooled
  connection keeps no session lock. A job that finds the lease taken answers
  "not yet" without spending an attempt. An entry's `first_version_id` is the
  first Fassung that holds it, whoever wrote that Fassung.
- **What came with a message is first-class** (D36). One
  `mail_thread_entry_attachments` row per attachment, whatever became of it:
  filed (document and Fassung), already in the project, or not filed with its
  reason. What the section prints for it is frozen at insert, and a name is
  printed only when the file sits in a folder at least as visible as the
  Verlauf and passed the Namensprüfung. The document routes answer
  `mailOrigins` per Fassung, through threads the reader may read, so Piloti and
  a person can tell which mail brought which Fassung.
- **Detach** (`mail-thread-entry-detach`) moves a message filed into the wrong
  conversation into another thread or a new one. The thread it leaves gets
  Fassung N+1 without the section: the one recorded exception to the superset
  invariant; earlier Fassungen keep it, and the confirmation says so. The row
  moves (DELETE is revoked), the thread it leaves is uploaded first, and every
  follow of that thread ends. An unwanted Verlauf is binned like any document;
  nothing "unfiles".

### The original `.eml` is evidence

When a message's text is filed, its raw message is moved to
`org/<org>/project/<project>/_mail-originals/<entryId>.eml` and recorded on the
entry: copied, read back and checked against its SHA-256, and only then is the
staged raw erased by its key (`original_move_pending_at` makes every step
retry-safe; sweep 13 finishes a move that stopped). It is kept because the
reply splitter, the signature cut and the HTML flattener are heuristics, an
inline sketch or a refused file type lives only there, and a DKIM signature is
re-verifiable only on those bytes.

- It is **never a document**: never indexed, never dispatched to ingestion or
  to `/v1/mail/read` after filing, never read by any model.
- **No agent door offers it**: `withheld`, category `evidence` (ADR-0122,
  amendment "evidence is on no door").
- **Whoever may read the Verlauf may download it**, and every download is
  scanned whole by ClamAV on that request and served only on `clean` (409
  `original_not_clean` otherwise), as `message/rfc822` with `nosniff`, and
  audited (`mail_thread.original_read`). The copy warns that a mail program
  loads remote images.
- It **lives exactly as long as its entry**: the Verlauf's document's life,
  covered by legal hold and the project purge.
- A held mail's original is downloadable the same way while it waits
  (`inbound-mail-original-get`). When only attachments are filed, no entry
  exists and the raw message is erased when the mail settles; the decision bar
  says so.

### Verlauf folgen: a person's standing decision

A person may follow one E-Mail-Verlauf (`mail_thread_follows`): 60 days by
default, renewable, at most 180 from its start, at most 20 appends a day. While
it runs, a later reply's **text** is appended to the Verlauf as that person,
with a decision row `via = 'follow'`. **Attachments always wait** for a person,
and the mail stays in the E-Mail-Eingang until they are decided; a text-only
mail settles. A reply joins only when all nine conditions hold; otherwise it
waits exactly as without a follow:

1. a follow is running and was made before the mail arrived;
2. the sender's domain is verified (`member_verified`, `external_verified`);
3. the match is `reference` to this thread, the header it rests on is signed,
   and so are From, Subject, Date, Message-ID and every To and Cc it carries;
4. none of `not_addressed_to_project`, `bcc_own`, `stale_date`,
   `date_out_of_range`, `message_id_reused`, `already_filed`,
   `claims_member_name`, and not automatic mail;
5. no new participant domain: every domain in From, To and Cc, the project's
   own excluded, already took part in the thread;
6. the Namensprüfung finds nothing in the subject and the content check
   nothing in the own text;
7. the follower still holds the `inbound-mail` entitlement,
   `project:documents:write`, read on the Verlauf and write in its folder, in
   an open project;
8. the follow's 20 a day and the project's 100 a day (rolling 24 hours), and
   the thread below its caps;
9. the Verlauf's document is live and screened.

The receive job judges 1–6 (`lib/mail-thread/follow-eligibility.ts`, pure) and
only then queues `inbound_mail_follow`. That job re-judges 1–6 with the same
function and adds 7–9 as the follower, resolved strictly (a directory that does
not answer retries, it never reads as "left"); then it writes the decision and
files through the filing job's own step. Several people may follow one Verlauf;
an append is made once, as the earliest running follower.

A follow ends by the person (`unfollowed`), by a manager
(`revoked_by_manager`), by expiry (`expired`, sweep 12), when the follower's
access is gone (`access_lost`), when the project's address is rotated or
switched off (`address_rotated`), on a detach in that Verlauf (`detached`),
when the document is gone (`document_gone`), and when the project is closed
(`project_closed`, the coordinator's product decision of 2026-10-27: a standing
decision to file replies ends with the work). Closing ends every running follow
of the project as the person who closed it; sweep 12 is the backstop and ends,
as the system, a follow it finds running in a closed project. Reopening starts
no follow again. Whether a follow should instead end after 60 quiet days rather
than run to 180 days with renewals is an open question to the owner; the 180
days stand. Every start, renewal and end is
audited (`mail_thread.follow_started`, `mail_thread.follow_ended`). Following
is a `control`-sensitive operation (ADR-0122): Piloti never sees it, an outside
agent only under the office's opt-in and the step-up scope. Ending is offered
to outside agents and not to Piloti: the standing decision is the person's own.
Archive imports and mail that arrived before the follow follow nothing.

### The Outlook archive renders into the same Verläufe

The archive import (ADR-0085) stays direct: starting it is the person's
decision. Its per-mail note is replaced: each mail's text becomes an entry
(`source = 'archive'`, `sender_trust = 'not_checked'`, no original) of the
project's E-Mail-Verläufe. It appends only on a strong match (`reference` or
`thread_index` with an equal subject, or a Verlauf that already cites the
mail), only into a Verlauf the importer may write, and otherwise opens a new
one named `{Gegenüber} {yyyy-mm-dd}`, never the subject. Mail the project
already holds is skipped by Message-ID, both ways: an archive entry makes a
later inbound copy `already_filed`, an inbound entry makes the archive skip the
text (`already_in_project`). Each touched Verlauf gets one Fassung per import
slice, under its render lease; the archive takes the lease for each entry it
writes into an existing Verlauf too. The amendment of ADR-0085 says what
changed and why.

### Who hears what (D35)

Filing is quiet. Each kind of mail filing opens its upload batch with the
effects of migration 0185 (`lib/inbound-mail/batch-effects.ts`):

| Upload | Completion summary | Content re-judgement | Intake reading | Revision notice | Document check (ADR-0130) |
|---|---|---|---|---|---|
| A person's upload | yes | yes | yes | all | yes |
| Inbound attachments | no (`inbound_mail.decided` and the toast cover it) | no (a person placed it) | yes | all (a new Fassung of S-101 is news) | yes |
| Inbound Verlauf append (person or follow) | no | no | no | marks only | no |
| Archive Verlauf render | yes | no | no | marks only | no |

One quiet batch per filing run, never per decision: a batch takes its effects
when opened, and a batch id derived from the decision would be sealed by the
first run, so a retry's uploads would be loud (`lib/inbound-mail/quiet-batch.ts`).

The E-Mail-Eingang's own notices are seven Postfach types, in-app and push
only; **we never send mail about mail**: `inbound_mail.waiting`,
`.expiring`, `.decided`, `.filing_failed`, `.cap_reached`, `.appended` and
`mail_thread.follow_expiring`. A row carries the project's name, a count and a
code, never a sender, subject or file name. A mail's notices go to its sender
only when it is `member_verified`, addressed to the project or the member's own
Bcc copy, and the member may read the project; otherwise to the project's
managers, so whoever forged a member's address never reaches that member
through us. The table: [`inbound-mail.md`](../architecture/inbound-mail.md#the-seven-notices).

### Exposure

- **Before filing, Piloti sees metadata only.** `inbound-mail-list` and
  `inbound-mail-get` carry the masked subject, the sender's domain, trust,
  flags, parts (name, state, scan, flags, suggestion) and the candidates the
  person may see. `inbound-mail-text-get` and `inbound-mail-part-content-get`
  are offered to outside agents acting as the person and not to Piloti.
- **Piloti suggests from names, never from content.** The suggestion
  (`/v1/filing-fit`, `basis: mail`) reads the attachments' names that passed
  the name check, the masked subject, the sender's domain, the folders every
  member may read and the office's conventions; never the text, never the bytes;
  not for an unconfirmed sender, automatic mail or an impersonation. Each
  decision scores it (`piloti-decision`, subject `inbound_mail_suggestion`;
  `mail-thread-match`).
- **Piloti may propose** `inbound-mail-file` and `inbound-mail-dismiss` as
  cards. A card files clean, unflagged parts only: the database refuses a
  `via = 'piloti_proposal'` decision with any acknowledgement or release.
- **An outside agent acts as the person.** `inbound-mail-file` and
  `inbound-mail-dismiss` carry `requiresPersonConfirmation` (ADR-0122): a
  client that cannot ask the person is refused with a link to the mail's page.
- **Originals are withheld from every door** (`evidence`).
- After filing, a Verlauf is third-party evidence in the grounding block, never
  instructions; `mail_origin.senderTrust` travels with it, so Piloti cites an
  unconfirmed sender as unconfirmed („laut E-Mail von … vom …“).

### Windows

| Item | Kept |
|---|---|
| A held mail | 30 days (`INBOUND_MAIL_WAIT_DAYS`, fixed at receipt); a notice five days before the end |
| Dismissed or expired parts | restorable 7 days, then erased; a dismissed part of an `external_unverified` mail is erased by the next sweep |
| A settled mail (ids, counts, trust) | while any filed part's document lives, else 30 days |
| A dropped mail (auto-reply, report, loop) | 30 days, its bytes erased at once |
| The original of a filed message | its entry's life: until the Verlauf's document is deleted |
| A follow | until it ends; ended follows go with their thread |

Expiry is not a delete: an expired mail is restorable for seven days like a
dismissed one. Thirty days, because holidays run three weeks and a lost
Bescheid is real harm. Code constants, no environment variables. A legal hold
on the project (and, for a mail's bytes, a custodian hold on the member it came
from) pauses every erasure and deletion; ending still happens. The sweeps:
[`inbound-mail.md`](../architecture/inbound-mail.md#retention-the-sweeps).

### What the database holds the code to (migration 0186)

Decided in the DDL, each deviating from the design document for a reason:

- **DELETE is revoked from `grid_app_rw` on eight of the nine tables** (all but
  `mail_thread_message_ids`, which a detach rewrites), not three: a tenant
  DELETE on an address or a thread would erase mail, decisions or filed
  messages through owner-rights cascades. Ending is a state; only the sweeps and
  the purge, as the platform role, delete.
- `inbound_mails → inbound_mail_addresses` is NO ACTION, not CASCADE, for the
  same reason.
- "Decisions are not deleted while unaudited" is a trigger, refused while the
  project row exists, so the sweeps wait for the audit trail and a purge still
  goes through.
- A thread's deletion (sweep 9) takes its follows' decisions and the message
  parts they filed along, once audited.
- What a section prints for an attachment is frozen at insert (the superset
  invariant), not resolved at render time.
- `mail_threads.locale` fixes a thread's rendition language for its life.

### Budget

The one model call before filing is the suggestion, queued `bulk`, checked
against `unaskedSpendAllowed` for the project (no member's budget: it is system
work), skipped for unconfirmed and automatic mail. Parsing, matching, rendering
and scanning make no model call. A Verlauf Fassung starts no intake reading, no
placement review and no document check.

### Consequences

* Good, because nothing reaches a project, an index or a model before a named
  person decided, and the database refuses the code path that would.
* Good, because a conversation is one citable document with its originals, in
  one shape for address mail and archive mail, and Piloti can answer what the
  Behörde wrote and which mail brought which Fassung.
* Good, because the common case is one press, a thread group files a
  conversation in one press, and a followed Verlauf takes replies' text without
  a press.
* Good, because anyone can write to a project and the office is protected:
  trust-shaped defaults, an impersonation stop, ClamAV, byte caps and rate
  limits (ADR-0138), and address rotation.
* Bad, because review is still work: every attachment of every mail waits for a
  person, and a busy project's E-Mail-Eingang needs a habit. A complete mail
  is one press in the list („Bereit“); the Postfach row and the push carry no
  filing action yet.
* Bad, because a project's mail is kept: originals of filed mail live as long as
  their Verlauf, which is a retention decision about third parties' data. The
  Datenschutzberater's sign-off (owner question Q1) is open, and the
  `inbound-mail` entitlement stays off for every office until it is given.
* Bad, because files the office does not accept (DWG, ZIP) cannot be filed;
  they survive only inside the original. Fetching cloud links is a follow-up.
* Bad, because one held document of a project pauses that project's mail
  erasure: `grid_legal_hold_blocks('project', …)` is true when anything in the
  project is held.
* Neutral: Message-IDs are not unique per project, on purpose. A forger can
  take a genuine id first; the genuine mail still files, flagged.

### Confirmation

- **Database** (`scripts/rls-test-db.sh`, the 0186 section, run by
  `task db:test:rls`): each refusal is a violating insert or update: a filing or
  filed part without a decision, or with a decision that is not a `file`; a
  system decider; a Piloti card with an acknowledgement; a follow decision by
  anyone but the follower, or on an attachment; a filed part whose scan was not
  clean; a waiting mail whose raw message was not scanned; a stored
  authentication line with `spf=`; a tenant DELETE; the legal-hold triggers.
- **Static ratchet** `lib/inbound-mail/review-first.spec.ts`: the webhook, the
  receive job, the suggest job and the sweep import no filing code.
- **Dynamic ratchet** `lib/inbound-mail/review-first.e2e.spec.ts`: a perfect
  `member_verified` mail with no follow runs to idle with no document; with a
  follow and a signed reference, exactly one new Fassung and the attachments
  still waiting; with References outside the signature or a new participant
  domain, none.
- `lib/mail-thread/follow-eligibility.spec.ts` fails each of conditions 1–6
  alone; `lib/mail-thread/follow.integration.spec.ts` the rest against
  Postgres.
- `lib/mail-thread/render.spec.ts` (golden files, the superset invariant with
  detach as its one exception, headings by source and trust, masked spans,
  escaping); `append.integration.spec.ts`; `archive.integration.spec.ts`;
  `lib/inbound-mail/sweep.integration.spec.ts` (every sweep, a held and an
  unheld project).
- Exposure: `exposure.config.spec.ts` and `tests/fixtures/exposure.json` hold
  the originals `withheld: evidence`, the held text and bytes `piloti: false`,
  and `mail-thread-follow` `control`-sensitive.
- `lib/inbound-mail/batch-effects.spec.ts` holds the "who hears what" table;
  `announce.spec.ts` feeds canaries through every notice and push.

## Pros and Cons of the Options

### Where a held mail lives

- Quarantäne: its question is screening, its deciders are admins, and its allow
  skips screening. Wrong question, wrong people.
- Freigabe: approves the content of a Fassung that exists, and its
  `notSubmitter` rule would forbid the most natural decider; and a held mail
  would need a `documents` row, which every listing and retrieval then has to
  exclude by hand.
- Proposal: acts on documents that exist, and vanishes when dismissed; a mail
  needs a seven-day restore.
- Own review object (chosen): no document exists until a person decides, and
  the decision rows are the record of who let what in. Costs nine tables.

### What a filed message becomes

- One document per message: a conversation of 40 messages is 40 documents, a
  folder of notes nobody reads as a thread, and Piloti cites them without their
  order.
- One document per conversation (chosen): Piloti reads the conversation once,
  each message stays citable as a section, and the Fassung timeline records
  when each arrived. Costs the superset invariant, the render lease and detach.

### The original

- Erase at settle: smaller, but loses the inline sketches, the refused file
  types, the bytes a heuristic misread and the re-verifiable signature, which
  is what a dispute asks for. v1 confused keeping a record with filing a
  document.
- Keep as a document: it would be indexed and readable by models, exactly what
  must not happen to a stranger's raw bytes.
- Keep as evidence (chosen).

### Filing without a click

- Never: a followed conversation of 30 replies is 30 presses for text the
  person already decided belongs there.
- Per sender: DKIM proves a domain, not a person, and a verified member's
  replayed mail to a third party would file itself.
- Per conversation under conditions (chosen): the person decided about this
  conversation; signed thread headers and no new domain keep a hijacked reply
  out; attachments are always reviewed.

## More Information

- The design document, its red-team dispositions and owner answers are the
  basis of this record (the project-mail work, DECISION v2 of 2026-10-22).
  Owner answers: four PRs; keep the original as evidence (B); the archive into
  the same Verläufe (C); ship „Verlauf folgen“ under the hijack conditions (D).
- Transport: ADR-0138. Scanner: ADR-0136. Amended here: ADR-0085 (archive into
  Verläufe), ADR-0086 (the name flag on mail), ADR-0122 (`evidence`,
  `requiresPersonConfirmation`).
- Revisit when: an office needs a narrower decider than every
  `project:documents:write` holder (FU16); per-office sender policy (FU9); the
  aligned-DKIM share of real project mail (launch gate G9) is so low that
  pre-selection and following rarely apply.
- Named follow-ups: FU2 (choose Outlook folders before import), FU4 (Fristen
  from messages), FU6 (ClamAV for ordinary uploads), FU8 (`.eml` dropped by hand),
  FU9 (sender policy), FU11 (merging Verläufe), FU12 (cloud links), FU15
  (re-render old archive notes).
- The architecture: [`inbound-mail.md`](../architecture/inbound-mail.md). The
  data: [`schema.md`](../database/schema.md#project-mail-migration-0186-adr-0137).
