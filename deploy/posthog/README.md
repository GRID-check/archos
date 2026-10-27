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
| [`slack-alert.hog`](support/slack-alert.hog) | „Piloti feedback → Slack (per deployment)" `01a16483-aaa2-0000-9400-98b42243aa65` | `product_feedback_ticket_opened`, `product_feedback_reply_sent` (the BFF's server events) | Posts a new report to `#support-tickets` per kind, with the claim button pointing at the event's `app_host`; a reporter's reply goes into the alert's thread. Bugs page `@here` on production only |
| [`claim-update.hog`](support/claim-update.hog) | „Piloti feedback: mark Slack alert claimed" `01a16445-c91c-0000-5f64-2f70e9c0e3b3` | `$conversation_ticket_assigned`, `assignee_type = user` | Rewrites every alert of the ticket, found in the channel history by the ticket id: the claim button goes, „✅ <taken_by> <Name>" appears |
| [`reply-poke.hog`](support/reply-poke.hog) | „Piloti feedback: tell Piloti about a team reply" `01a16498-573f-0000-1b68-8fb6438e0cc0` | `$conversation_message_sent`, `author_type = team` | POSTs `{ ticketId }` to `https://<origin>/api/webhooks/posthog-support`; the host comes from the ticket's `origin:<host>` tag and must be in the `allowed_hosts` input |

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

The two Slack destinations also take `copy` (JSON): every word they post. The
code is English like the rest of the repo and reads `inputs.copy.<key>`; the
German values live in [`support/copy.de.json`](support/copy.de.json), the
way the app keeps its i18n dictionaries. Paste that file into the `copy` input
when it changes. `tests/test_posthog_hog_copy.py` fails German in the `.hog`
code and a key the code reads that the dictionary lacks.

The older workflow „Piloti feedback → Slack" (`01a163d8-dfc6-0000-3e2d-82d9d653bc47`)
posted from PostHog's own `$conversation_message_received`, which cannot say
which deployment a ticket came from, so its claim button always pointed at
production. It also posted every report a second time, to `#posthog-inbox`.
Archived on 2026-10-27, after the per-deployment destination was seen posting
the same reports to `#support-tickets`.

## Answer quality to Slack

No `.hog` file: the destination is PostHog's own Slack template with its inputs
set, so there is no code of ours to review.

| Destination in PostHog | Trigger | What it does |
|---|---|---|
| „Piloti answers: thumbs-down with a reason → Slack (prod)" `01a17e99-0271-0000-4f5a-8c22030a5fd0` | `answer_feedback_submitted` with `verdict = down`, `reason` set and `$host = app.piloti.at` | Posts to `#support-tickets`: the reason („Ungenau", „Falsche Quelle", „Zu langsam", „Sonstiges"), the office, the page, the conversation and message ids, and links to Platform → Answer quality and the person's replays. The vote's comment never reaches PostHog, so it is not in the post |

A thumbs-down without a reason does not post: it is the cheapest click in the
app and on its own says too little to act on.
