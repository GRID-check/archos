---
status: accepted
date: 2026-10-20
decision-makers: Platform
consulted: Product
informed: everyone who ships to this repo
---

# PostHog Support is the record of triage for product feedback

## Context and Problem Statement

A member can send the people who run Piloti a bug report, an idea, praise or a
question from the Feedback dialog. ADR-0100 put support in PostHog and had the
dialog "also open a support conversation". What shipped kept two systems:

* **Postgres** stored every report in `product_feedback` with its own triage:
  `status` (`new`, `in_progress`, `resolved`, `dismissed`), `triaged_by` and
  `triaged_at`, moved on **Platform → Feedback**.
* **PostHog Support** got a ticket from the browser, through
  `posthog.conversations.sendMessage`, and only when the reporter allowed
  contact.

The two status systems shared nothing. A report marked resolved on the platform
page stayed open in PostHog, and a ticket answered in PostHog stayed new on the
page. Reports whose reporter declined contact never reached PostHog at all, so
PostHog could not be the place to work through feedback even in principle.
In practice no ticket opened at all: the `/ingest` relay dropped the
`X-Conversations-Token` header, PostHog answered 403, and the browser swallowed
the error by design. That relay bug is fixed separately
([gotchas](../contributing/gotchas.md)); it showed that a browser-opened
ticket fails silently, and that nobody notices while a second status system
looks complete.

Which system is the record of where a report stands, and who opens the ticket?

## Decision Drivers

* **One status per report.** Two status systems drift, and the one people read
  is always the wrong one.
* **Buy, don't build** (AGENTS.md). PostHog Support already has statuses,
  assignment, replies to the reporter's widget, the session replay beside the
  ticket and an audit of who moved what. Our triage page had a status column.
* **Every report reaches the triage queue,** whether or not the reporter wants
  to be contacted, and whether or not their browser can reach PostHog.
* **Only masked text leaves for a third party.** The report goes through the
  office's „Sensible Daten" policy (ADR-0086) first. That pass runs on the
  server, so the server holds the masked copy.
* **A report is never lost** while PostHog is off, misconfigured or down, and
  the in-app inbox announcement (`feedback.submitted`, ADR-0035) needs a row to
  point at.

## Considered Options

* **PostHog Support is the record of triage. The BFF opens a ticket for every
  report; Postgres keeps the intake log and the ticket id.**
* Keep our own triage in Postgres and only link each report to its ticket.
* Drop the Postgres row and keep feedback in PostHog alone.
* Keep opening the ticket from the browser, and move triage to PostHog.

## Decision Outcome

Chosen option: **PostHog Support is the record of triage, and the BFF opens the
ticket**, because it is the only option with one status per report that still
reaches PostHog for every report and still keeps a report when PostHog cannot.

What that means:

| Concern | Where | How |
|---|---|---|
| Opening the ticket | BFF, `submitProductFeedback` in `frontends/ui/src/lib/product-feedback/service.ts` | After the report is stored and announced, for every report. Through PostHog's public widget endpoint, in the reporter's widget session (`widgetSessionId` and `sessionId` from the browser, a fresh widget session when the browser has none), with the reporter's distinct id (the WorkOS user id) |
| The ticket's text | BFF | `[<kind>] #<report id> <page path>`, a newline, then the text after `maskChatText`. When the policy cannot be read, no ticket opens: never the unmasked text |
| Tags | BFF, then PostHog | `piloti-feedback` on every ticket, `kind:<kind>`, and `no-contact` when the reporter declined contact, so nobody replies |
| Status | PostHog Support | PostHog's own statuses, verbatim: `new`, `open`, `pending`, `on_hold`, `resolved` |
| Platform → Feedback | BFF, reading PostHog live | Lists the tickets tagged `piloti-feedback` joined to their local rows, counts per status, a link to each ticket. A status change PATCHes the ticket. Reports from the last 30 days without a ticket are listed as not in PostHog yet, with a link to the reporter's PostHog person page |
| Fallback | Postgres | While Support is not configured or PostHog cannot be read, the page lists the local log, read-only |
| The intake log | Postgres, `product_feedback` | What was sent, by whom, from where, and `posthog_ticket_id`. Its `status`, `triaged_by` and `triaged_at` are dropped (migration `0155`) |
| The inbox announcement | Postgres, `feedback.submitted` | Unchanged |
| Server configuration | BFF environment | `POSTHOG_PERSONAL_API_KEY` (secret; scopes `ticket:read`, `ticket:write`, `project:read`) and `POSTHOG_PROJECT_ID`, from the Pulumi keys `grid-oib:posthogPersonalApiKey` and `grid-oib:posthogProjectId`. Without both, no ticket opens and the page shows the local log |

Votes on answers (`answer_feedback`) are not product feedback and do not change.

### Consequences

* Good, because a report has one status, and it is where the replies, the
  replay and the assignment already are.
* Good, because every report reaches PostHog, including those from reporters
  who declined contact and those whose browser blocks PostHog. The `no-contact`
  tag keeps the first group from getting a reply.
* Good, because the ticket's text comes from the server's masked copy and the
  browser never sends report text to PostHog.
* Good, because a missing ticket is visible: the page lists those reports as
  not in PostHog yet, and the server logs why.
* Bad, because the BFF now holds a personal API key, which is tied to the person
  who created it. A person with PostHog access has to create it, and it has to
  be rotated when they leave.
* Bad, because the platform page now depends on PostHog for anything but a
  read-only view. While PostHog is down, nobody can move a report.
* Bad, because the BFF opens tickets through PostHog's widget endpoint, which is
  the endpoint posthog-js uses, not a documented server API. A change to it
  breaks ticket opening; reports are still stored and shown as not in PostHog
  yet.
* Bad, because the local status history is dropped with migration `0155`.
  Reports filed before it have no ticket; those under 30 days old show as not
  in PostHog yet, and older ones are only in the local log.

### Confirmation

* Migration `0155_product_feedback_posthog_ticket.sql` drops the local status
  columns, so nothing can write a second status. A CHECK bounds
  `posthog_ticket_id` to an id-shaped string, because it ends up in a link.
* The specs beside `frontends/ui/src/lib/posthog-support/client.ts` and
  `frontends/ui/src/lib/product-feedback/service.ts` pin the tags, the masked
  text, the no-ticket-without-masking rule and the local fallback.
* Nothing enforces that a deployment sets the two keys. Without them the page
  says so by showing the local log.

## Pros and Cons of the Options

### Keep our own triage, link to the ticket

* Good, because the platform page works without PostHog.
* Bad, because two status systems drift. That is the problem this record
  exists to fix, and a link does not keep them in step.
* Bad, because it keeps a triage page we wrote beside one we buy.

### Drop the Postgres row entirely

* Good, because there is one store, not two.
* Bad, because a report sent while PostHog is off, misconfigured or failing
  would be lost.
* Bad, because the inbox announcement (`feedback.submitted`) needs a row to
  point at, and the reporter's organization, page and context have nowhere else
  to live under RLS.

### Let the browser open the ticket

* Good, because the browser already has the widget session, and no server key
  is needed to open a ticket.
* Bad, because reports whose reporter declined contact, and every browser that
  blocks PostHog, get no ticket, so PostHog could not be the queue.
* Bad, because the masked text is the server's. Handing it to the browser to
  send on is a second hop for nothing, and a failure there is swallowed where
  nobody sees it (it hid the relay bug).

## More Information

* Amends ADR-0100: its Support row ("the product-feedback dialog also opens a
  support conversation") becomes "the BFF opens a Support ticket for every
  product-feedback report, and PostHog Support is where it is triaged".
* How the feature works: [`../architecture/product-feedback.md`](../architecture/product-feedback.md).
  The checklist item for the key:
  [`../observability/posthog-migration.md`](../observability/posthog-migration.md#checklist).
