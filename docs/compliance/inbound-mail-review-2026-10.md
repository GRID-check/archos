# Project mail: data-protection review (October 2026)

- **Date:** 2026-10-27, against the project-mail branch (ADR-0134, ADR-0135).
- **What it covers:** mail that third parties send to a project's address, the
  E-Mail-Verläufe it is filed into, the original `.eml` kept as evidence, the
  standing decision to follow a Verlauf, Piloti's metadata suggestion, and the
  Outlook archive rendering into the same Verläufe.
- **Status: Datenschutzberater sign-off OPEN.** Every section marked
  **[sign-off]** needs a human data-protection decision before the
  `inbound-mail` entitlement is switched on for any customer (owner gate O7,
  [`kubernetes.md` §3c](../deployment/kubernetes.md#3c-project-mail-cloudflare-email-routing-adr-0135)).
  This document is an engineering inventory, **not legal advice**.

## Roles

The office publishes the project's address and decides what is filed, so the
office is the **controller** of the mail third parties send to it. Piloti's
operator processes it on the office's behalf (Art. 28 DSGVO), as it does the
office's other project content. **[sign-off]** The customer terms (AVV) need a
paragraph saying so; a draft is at the end of this document.

## What is stored, where, and for how long

| Data | Where | Kept | Erased by |
|---|---|---|---|
| The raw message while it waits (`raw.eml`), `read.json` (the reader's text, quotes, invitations) and each attachment | the organization's bucket, `org/<org>/project/<project>/_inbound-mail/<mailId>/` | while the mail waits (30 days), then 7 days restorable after a dismissal or expiry | key-exact erasure when the mail settles (sweep 6), at once for a dismissed part of an `external_unverified` mail, sweep 1 for a reception that never finished |
| A held mail's metadata: sender address and name, subject, participants (From, Reply-To, To, Cc), Message-IDs, sender trust and flags, our authentication line | `inbound_mails` | while waiting; scrubbed to ids, counts, trust and the member it came from when it settles (a CHECK) | the row: 30 days after settling unless a filed part's document lives; dropped rows 30 days after receipt (sweep 8) |
| Parts: file names, sizes, hashes, scan verdicts, Piloti's suggestion | `inbound_mail_parts` | the name only while the bytes are there (a CHECK) | with the mail row |
| Decisions: who filed, dismissed or restored which part, how (app, agent, Piloti card, follow) | `inbound_mail_decisions`, and the WorkOS audit trail (`inbound_mail.decided`) | never deleted before the audit trail took it (a trigger); then with the mail or its thread | sweeps 8 and 9 |
| A filed message's text, sender name and domain, participants by name and domain, quotes, invitations | `mail_thread_entries` and the E-Mail-Verlauf document (Markdown, indexed like any document) | as long as the Verlauf's document | deleting the document; sweep 9 then deletes the thread and its entries |
| **The original `.eml` of a filed message** | `…/_mail-originals/<entryId>.eml` | **as long as its entry, i.e. the Verlauf's document** | sweep 9, by key, before the thread row is deleted; the project purge |
| What came with a filed message (name, disposition, the document and Fassung it became) | `mail_thread_entry_attachments` | as long as its entry | with the entry |
| Message-IDs for matching | `mail_thread_message_ids` | as long as the thread | with the thread |
| Follows: who follows which Verlauf, until when, why it ended | `mail_thread_follows`; audit `mail_thread.follow_started` / `.follow_ended` | until the thread is deleted | with the thread |
| The address and its rotation history | `inbound_mail_addresses` | until the project is purged | the project purge |
| Product analytics | PostHog: ids, counts, codes, trust labels; never a sender, subject, file name or address | PostHog's retention (12 months) | — |
| Transit | Cloudflare Email Routing (the MX) and the Email Worker | Cloudflare's Email Routing activity log (sender, recipient, time, outcome); the Worker logs nothing (observability off, no Logpush) | Cloudflare's own retention **[sign-off: confirm Cloudflare's activity-log retention and DPA coverage]** |
| Malware scans | the in-cluster ClamAV | nothing: bytes arrive on a socket and are gone with the reply | — |

Filed attachments are ordinary documents: they live, are deleted and are
purged as documents are, and carry `mail_origin` (sender name, domain, trust,
times) on their knowledge-layer row.

**[sign-off] Keeping originals for the Verlauf's life.** An original holds a
third party's whole message, including parts the office did not file (refused
file types, inline pictures, quoted history). It is kept because it is the
evidence of what was sent: heuristics turned it into the Verlauf's text, and a
DKIM signature can be re-verified only on those bytes. It is never indexed and
no model reads it; whoever may read the Verlauf may download it, scanned whole
on each download and audited. The open question for the Datenschutzberater
(owner question Q1): whether received business letters fall under UGB §212 /
BAO §132 (seven years), which would argue for a **minimum** original lifetime,
or whether the Verlauf's life is too long for mail the office did not file.

## Who can see what

- A held mail (metadata, masked text, attachments before filing, its original):
  holders of `project:documents:write` on the project, and org admins, with the
  office's `inbound-mail` entitlement. Candidates (threads, earlier Fassungen,
  duplicates) are computed per viewer and filtered by folder visibility.
- A Verlauf and its originals: whoever may read the Verlauf's document.
- Notices: a mail's notices go to its sender only when that sender is a
  member whose domain signed it and who may read the project; otherwise to the
  project's managers. No notice or push carries a sender, a subject or a file
  name. No e-mail is ever sent about mail.
- **[sign-off]** The decider group is every `project:documents:write` holder
  (FU16 would narrow it). The user guide tells offices not to send fee or
  personnel mail to the project address.

## External senders

Anyone who knows the address can write to it, because a conversation where the
project is only in Cc grows through other people's replies. Every mail is held;
nothing is filed without a person. The safeguards: ClamAV on every attachment
and the whole raw message before anyone can act on it; rate limits and byte
caps per address and organization; address rotation; no model call for mail
from an unconfirmed domain or automatic mail; an impersonation stop.
**[sign-off]** Holding a third party's whole mail for up to 30 days (plus 7
restorable) before anyone decided.

## Models

- **Before filing, no model Piloti runs reads a held mail's text or bytes.**
  The one model call is Piloti's filing suggestion, and its input is exactly:
  the attachments' file names that passed the office's name check, the
  subject masked by the office's content check, the sender's domain, the
  project's folders every member may read, and the office's folder conventions
  (folders kept by at least two of its projects). Not for unconfirmed senders,
  impersonating mail or automatic mail. It goes through OpenRouter like every
  model call. **[sign-off]** This is the processing the privacy text names.
- After filing, a Verlauf and its attachments are project documents and reach
  the office's chosen model like any document (embeddings, retrieval, answers).
- The original `.eml` reaches no model, ever, and is withheld from every agent
  door.

## Following a Verlauf

A person's standing decision, per conversation, up to 180 days: later replies'
**text** from confirmed domains already in the conversation is appended without
a click, filed as that person, audited per append. Attachments always wait for
a person. **[sign-off]** A standing decision to file third parties' future
messages.

## Legal hold

Every sweep that erases or deletes asks
`grid_legal_hold_blocks('project', project_id, organization_id)` in its WHERE,
and a mail's bytes also ask about a custodian hold on the member it came from.
`grid_legal_hold_blocks('project', …)` is true when **anything in the project**
is held (a document, a folder, a conversation, a user; migration 0115), so one
held document pauses that project's whole mail erasure: held mail still expires
and settles for the people using it, but its bytes and rows are kept
(`erasure_deferred_at`) until the hold is lifted, then erased by sweep 10.
`BEFORE DELETE` triggers on the mail, entry and attachment tables are the
backstop (SQLSTATE `GLH01`).

## Data subjects' requests

A sender asking for erasure is the office's request to answer as controller.
Today: dismissing a held mail erases it within 7 days; deleting the Verlauf
document erases its entries and originals (sweep 9). There is no per-sender
erasure across Verläufe. **[sign-off]** Whether that suffices.

## Sub-processors

| Who | Role | New with project mail |
|---|---|---|
| Cloudflare, Inc. | DNS (as before) **and now transit of mail sent to project addresses** (Email Routing, the Email Worker); USA, worldwide network | the purpose widens; listed on the app's sub-processor page |
| ClamAV (self-hosted) | malware scanning in the cluster; no third-party processing | listed in the self-hosted table |
| OpenRouter and the chosen model provider | Piloti's metadata suggestion (names, masked subject, domain) | no new processor; a new input |

## Draft paragraphs

**[sign-off] AVV (customer terms), draft.** „Stellt der Kunde eine
E-Mail-Adresse eines Projekts bereit, ist er Verantwortlicher für die
E-Mails, die Dritte an diese Adresse senden. Der Auftragsverarbeiter nimmt
sie über Cloudflare, Inc. (Weiterleitung, USA) entgegen, prüft Anhänge im
eigenen Cluster auf Schadsoftware und hält sie bis zu 30 Tage zur Entscheidung
durch berechtigte Personen des Kunden bereit. Abgelegte E-Mails werden Teil der
Projektunterlagen; ihr Original (.eml) wird als Nachweis so lange aufbewahrt wie
das zugehörige Dokument und keinem KI-Modell zugänglich gemacht.“

**[sign-off] Art. 30 record, entry draft.** Purpose: receiving project
correspondence for the customer's projects and filing it on a person's
decision. Categories of data subjects: senders and recipients of mail to a
project address (the customer's members and third parties). Categories of
data: names, e-mail addresses, message content, attachments, technical
authentication results. Recipients: the customer's authorised members;
Cloudflare (transit); OpenRouter and the chosen model provider (metadata only,
before filing). Transfers: USA (Cloudflare; OpenRouter), on the bases in the
privacy policy. Retention: as in the table above. Technical and organisational
measures: review before filing, malware scanning, rate limits, signed
transport, tenant isolation, audit trail, legal hold.

## Shipped text

- The app's privacy policy and sub-processor page
  (`frontends/ui/src/lib/legal/content/{de,en}.ts`): the processing purposes,
  the suggestion's exact inputs, Cloudflare's widened row and the ClamAV row;
  `content.spec.ts` holds the copy to them.
- The public privacy page (`frontends/web/src/i18n/ui.ts`, `legal.datenschutz`),
  which the bounce text links senders to: a section for people who write to a
  project address.
- The help page `/e-mail-eingang/` (`/en/project-mail/`), also linked from the
  bounce.

All three need the same sign-off before an office is switched on.
