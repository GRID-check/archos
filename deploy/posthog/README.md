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

## Slack channels

One channel per question someone acts on. The PostHog Slack app (integration
91399) must be a member of each channel (`/invite @PostHog`), or every post
fails with `not_in_channel`.

| Channel | ID | The question it answers | What posts there |
|---|---|---|---|
| `#alerts-prod` | `C0CCG0Z1EKF` | Is production broken? | The „Platform health (prod)" alert; error-tracking spikes (`01a15d7e…`) and upstream outages, created and reopened (`01a159e8-d931…`, `01a159e8-dc54…`) |
| `#support-tickets` | `C0CBG0ZC0TB` | Does a member wait for us? | New reports and replies (`support/`), the 24-hour reminder |
| `#answer-quality` | `C0CCKAS3TRC` | Where did Piloti answer badly? | Thumbs-down votes with a reason |
| `#piloti-metrics` | `C0CDFLKKYRE` | What does it cost, and how is the week going? | The „Costs and budgets (prod)" alert, the Monday report |
| `#posthog-inbox` | `C0CAHK8EYAF` | | Nothing any more: every destination moved to the channels above on 2026-10-27 |

## Alerts

The plan allows five insight alerts, so each alert covers one area. Its
insight computes one row per rule internally, then folds them into **one
row**: `rule` lists every rule that fired, joined with ` | ` („Keine Regel
verletzt" when none did), and `breach` counts them. An alert notifies when it
starts firing, not on every check.

Keep the result to one row. A scheduled check of an `any_row` alert over a
multi-row result errored on every run with only „This alert encountered an
error" (2026-10-27; the same query ran fine in the SQL editor, and
`alert-simulate` refuses `any_row` alerts, so nothing shows the real error).
Fold a new rule in with the same wrapper:
`SELECT … FROM (SELECT rule AS r, breach AS b FROM (<the per-rule rows>))`.
The inner columns are renamed because ClickHouse refuses an outer
`countIf(breach > 0)` over an inner `breach` alias.

| Alert | Insight | Checked | Rules |
|---|---|---|---|
| Platform health (prod) | `tqqimEor` | hourly | The five per-area health tables of `docs/observability/metrics.md`, merged, plus „production sends no metrics at all", which the old heartbeat could not see: it only noticed a service that sent and then stopped |
| Support: feedback ticket waiting 24h+ (prod) | `gsIfpLwh` | hourly | A prod ticket, contact allowed, where the reporter spoke last more than 24 h and less than 7 days ago. Read from `$conversation_message_*` events: PostHog emits no event when a ticket is resolved, so a ticket resolved without a reply stays listed until its 7 days pass |
| Costs and budgets (prod) | `1GfF4oj1` | hourly | An office at 90 %+ of its monthly budget or blocked by it; today's LLM cost above 25 USD and above twice the 14-day daily average; Claude chat reading under 20 % of its input from the prompt cache over 24 h (it read 0 % for a month until 2026-10-27, `packages/agent/src/aiq_agent/common/prompt_caching.py`). Cost equals price on the price list today, so a negative-margin rule would never fire |

## Destinations outside `support/`

| File | Destination in PostHog | Trigger | What it does |
|---|---|---|---|
| none: PostHog's Slack template with its inputs set | „Piloti answers: thumbs-down with a reason → Slack (prod)" `01a17e99-0271-0000-4f5a-8c22030a5fd0` | `answer_feedback_submitted` with `verdict = down`, `reason` set and `$host = app.piloti.at` | Posts to `#answer-quality`: the reason, the office, the page, the conversation and message ids, links to Platform → Answer quality and the person's replays. The vote's comment never reaches PostHog. A thumbs-down without a reason does not post: on its own it says too little to act on |
| [`surveys/chat-message-count.hog`](surveys/chat-message-count.hog) | „Piloti: count chat messages per person (NPS audience)" `01a17ea6-7a0c-0000-b8fe-252e2147be8c` | `chat_message_sent` | Sets the person property `chat_messages_total`, which the NPS survey targets (≥ 15) |

## Surveys and reports

| What | When | Audience |
|---|---|---|
| CSAT „nach Export" | 3 s after `report_exported` | 30 % of people, once per 30 days across surveys |
| NPS „power users" | 5 s after `chat_message_sent` | `chat_messages_total` ≥ 15, once per 90 days |
| „Piloti Wochenbericht" (subscription 58130) | Mondays 07:00 UTC | AI-written report to `#piloti-metrics`: usage, answer quality, support, costs, errors, against the week before |

## Announcements

In-app announcements (a window or a banner, for a new guideline or a model
switch) are PostHog product tours, created in the PostHog UI. How to send one,
target it and read its reach: [`announcements.md`](announcements.md).
