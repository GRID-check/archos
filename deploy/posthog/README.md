# PostHog automation: `deploy/posthog`

Code that runs inside PostHog rather than in our images. PostHog stores it; this
directory is the copy we review, so a change to a destination is a diff here
first and a save in PostHog second. Nothing applies these files automatically:
paste the source into the destination (PostHog → Data pipelines → Destinations,
or the PostHog MCP `cdp-functions-partial-update`), test it with a real event,
then enable it.

Staging (`app.dev.piloti.at`) and production (`app.piloti.at`) share one
PostHog project (269895). Every destination below therefore works out which
deployment a ticket belongs to before it links to or calls one.

## `support/`: product feedback in PostHog Support

The flow is described in
[`docs/architecture/product-feedback.md`](../../docs/architecture/product-feedback.md).

| File | Destination in PostHog | Trigger | What it does |
|---|---|---|---|
| [`slack-alert.hog`](support/slack-alert.hog) | „Piloti feedback → Slack (per deployment)" `01a16483-aaa2-0000-9400-98b42243aa65` | `product_feedback_ticket_opened`, `product_feedback_reply_sent` (the BFF's server events) | Posts a new report to `#support-tickets` per kind, with „Übernehmen" pointing at the event's `app_host`; a reporter's reply goes into the alert's thread. Bugs page `@here` on production only |
| [`claim-update.hog`](support/claim-update.hog) | „Piloti feedback: mark Slack alert claimed" `01a16445-c91c-0000-5f64-2f70e9c0e3b3` | `$conversation_ticket_assigned`, `assignee_type = user` | Rewrites every alert of the ticket, found in the channel history by the ticket id: the claim button goes, „✅ Übernommen von <Name>" appears |
| [`reply-poke.hog`](support/reply-poke.hog) | „Piloti feedback: tell Piloti about a team reply" `01a16498-573f-0000-1b68-8fb6438e0cc0` (disabled until the endpoint is deployed) | `$conversation_message_sent`, `author_type = team` | POSTs `{ ticketId }` to `https://<origin>/api/webhooks/posthog-support`; the host comes from the ticket's `origin:<host>` tag and must be in the `allowed_hosts` input |

Two things the live runtime does differently from the test runner
(`cdp-functions-invocations-create`), both found the hard way:
`postHogUpdateTicket` runs in a test and silently stops a live run, so no
destination writes to a ticket; and a live run logs nothing of a failure
before its first `print`, so every destination prints each step it completes.
Test a change by sending the real trigger event (the capture API with the
project token) and reading the destination's logs, not only by test-invoking it.

Inputs each destination needs: the Slack integration (`slack_workspace`,
integration 91399) and `channel` (`C0CBG0ZC0TB`) for the two Slack ones;
`default_host` (`app.piloti.at`) for the alert; `assignee_names` (PostHog user
id → display name, optional) for the claim update; `allowed_hosts`
(`["app.piloti.at", "app.dev.piloti.at"]`) for the poke.

The older workflow „Piloti feedback → Slack" (`01a163d8-dfc6-0000-3e2d-82d9d653bc47`)
posted from PostHog's own `$conversation_message_received`, which cannot say
which deployment a ticket came from, so its claim button always pointed at
production. Disable it once both deployments send the server events above.
