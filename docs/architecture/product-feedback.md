# Product feedback and the inbox's platform lane

A member can send the people who run Piloti a bug report, an idea, praise or a
question from anywhere in the app. The platform owners are told in their inbox,
every report opens a ticket in PostHog Support, and the owners work through the
reports on **Platform → Feedback**, which reads and moves those tickets. PostHog
Support is the one record of where a report stands (ADR-0118). This is separate
from the thumbs on an answer (`answer_feedback`, which feeds platform lessons).
A product report never reaches that pipeline.

## The flow

```
member ── Feedback senden ──▶ POST /api/feedback/reports
                                 │
                                 ├──▶ product_feedback (reporter's org, RLS): the intake log
                                 ├──▶ feedback.submitted inbox rows (platform org, one per owner)
                                 └──▶ PostHog Support ticket (BFF, masked text, every report)
                                        └──▶ product_feedback.posthog_ticket_id
owner's inbox (platform lane) ──▶ /app/platform/feedback?report=<id>
Platform → Feedback ──▶ reads PostHog tickets live ──▶ PATCH status on the ticket
```

| Step | Code |
|---|---|
| The form, and its entry points (avatar menu, org header) | `frontends/ui/src/features/product-feedback/components/feedback-dialog.tsx`, `feedback-provider.tsx` |
| Submit route, rate limited by `FEEDBACK_REPORT_LIMIT` (10 an hour per person) | `frontends/ui/src/app/api/feedback/reports/route.ts` |
| Store, announce, open the ticket | `frontends/ui/src/lib/product-feedback/service.ts`, `announce.ts` |
| The PostHog Support client (open, list, read, change status) | `frontends/ui/src/lib/posthog-support/client.ts`, `config.ts`, `types.ts` |
| Table, bounds, RLS | `frontends/ui/drizzle/0100_product_feedback.sql`, `0155_product_feedback_posthog_ticket.sql` |
| Platform routes (`platform:settings:view` to read, `:manage` to change status) | `frontends/ui/src/app/api/platform/feedback/` |
| Platform page | `frontends/ui/src/features/product-feedback/components/feedback-triage.tsx` |

The page, the browser and the screen size are captured when the form is sent
and shown to the reporter before sending. The reporter's email reaches the
platform page only when they ticked "you may contact me".

## Who is told

Active members of the GRID Platform organization whose role holds
`platform:settings:manage`. That is the same rule the storage alert uses: a
permission, never a role name, and an unknown role holds nothing.
Break-glass owners (`GRID_PLATFORM_OWNER_EMAILS`) are not members, so they are
not told. They still see every report on the page.

Announcing fails open. The report is stored first, and a WorkOS failure while
resolving the roster is logged instead of costing the reporter their
confirmation. The inbox notification (`feedback.submitted`) does not depend on
PostHog.

## The Support ticket in PostHog

The BFF opens a Support ticket for every report, after storing and announcing it
(`openTicketFor` in `lib/product-feedback/service.ts`). The browser sends no
report text to PostHog.

- **The text is the server's, masked.** The first message is
  `[<kind>] #<report id> <page path>`, a newline, then the message after
  `maskChatText`, the same pass a vote's comment goes through against the
  office's „Sensible Daten" policy (ADR-0086). The stored report keeps what was
  typed; only the masked copy leaves for a third party. When the policy cannot
  be read, no ticket opens: never the unmasked text.
- **In the reporter's widget session.** The dialog sends the browser's PostHog
  widget session and session id with the report (`posthog` in the request,
  from `getPosthogSupportContext`). The ticket opens through PostHog's widget
  endpoint under the reporter's distinct id (the WorkOS user id), so replies
  show in their widget and the ticket links the session replay. A browser
  without PostHog sends none; the server then starts a fresh widget session, and
  the ticket can be triaged but not answered through the widget.
- **Tagged.** Every ticket carries `piloti-feedback`, which is how the platform
  page finds it and keeps tickets opened by hand out, and `kind:<kind>`. A
  reporter who did not tick "You may contact me about this" still gets a ticket,
  tagged `no-contact`: read it, never reply.
- **Remembered.** The ticket id lands in `product_feedback.posthog_ticket_id`.
- **Best effort.** The report is stored before the ticket opens, and no ticket
  failure fails the request. The server logs why a ticket did not open, and the
  platform page lists the report as not in PostHog yet.

The server needs `POSTHOG_PERSONAL_API_KEY` (secret; scopes `ticket:read`,
`ticket:write`) and `POSTHOG_PROJECT_ID`, from the Pulumi keys
`grid-oib:posthogPersonalApiKey` and `grid-oib:posthogProjectId`. The widget
token is read keyless from the project's public remote config, and the ticket
call carries this deployment's origin, which must be listed in PostHog's
Support → Allowed domains. A person with
PostHog access creates the key
([checklist](../observability/posthog-migration.md#checklist)). Without both,
no ticket opens.

## Platform → Feedback

The page reads PostHog live and keeps no status of its own.

- **Statuses are PostHog's:** `new`, `open`, `pending`, `on_hold`, `resolved`,
  with a count for each. Changing a report's status PATCHes its ticket, and
  PostHog records who did it.
- **Each report links to its ticket.** The list is the tickets tagged
  `piloti-feedback`, newest first, joined to their local rows for the words,
  the reporter and the organization.
- **Reports without a ticket** from the last 30 days are listed apart, as not in
  PostHog yet, with a link to the reporter's PostHog person page instead.
- **Fallback.** While Support is not configured, or PostHog cannot be read, the
  page lists the local log, read-only: no statuses, no status change.

`product_feedback` is the intake log: what was sent, by whom, from where, and
the ticket id. Its `status`, `triaged_by` and `triaged_at` columns were dropped
in migration `0155`. It stays because a report must survive PostHog being off
or failing, and because the inbox announcement points at it.

## No GitHub issues

Bug reports used to be filed as GitHub issues too (`GRID_FEEDBACK_ISSUES_REPO`,
err2issue's token). That is gone: it was off in production, borrowed another
tool's PAT, and the issue could not be traced back to the report. A bug keeps
its Postgres record, the platform owners' inbox row and its Support ticket.
Triage belongs in PostHog Support; nothing here files into an issue tracker.

## The platform lane

The announcement rows are written into the **platform organization**, because
the reporter's tenant has no business holding the platform's mail. Platform
owners mostly work inside some tenant organization, and the inbox used to list
only the active organization's rows. So the inbox service reads in **lanes**
(`frontends/ui/src/lib/inbox/service.ts`):

- the tenant lane: the active organization, and the types `visibleInboxTypes`
  allows;
- the platform lane: the platform organization and the `gate: 'platform'` types.
  It exists only when the reader holds `platform:settings:view`.

Each lane runs as its own organization (`withTenant`), so RLS still sees one
tenant at a time. List, badge, mark-read and archive all go across lanes. The
lanes never share a type, so an owner acting inside the platform organization
still sees each row once.

## Email: declared now, sent later

Every inbox type states its email default in the registry
(`INBOX_TYPE_DEFINITIONS[type].email`, spec IB-5 and IB-11):

- `never` means in-app only;
- `if-unread` with `afterMinutes` means mail a reminder when the row is still
  unread after that long. Reading, archiving or resolving it in the app first
  cancels the mail.

`feedback.submitted` is `if-unread` after 0 minutes, so it is mailed as soon as
a sender exists. **Nothing sends mail yet.** `frontends/ui/src/lib/inbox/delivery.ts`
is the tested contract a sender is built against. Its module comment lists the
steps. The one to get right: the `emailed_at` column ships in the same
migration as the sender. Added earlier, every existing row reads as "due,
never sent", and the first sweep mails the backlog.
