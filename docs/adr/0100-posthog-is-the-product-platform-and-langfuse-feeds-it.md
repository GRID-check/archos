---
status: accepted
date: 2026-10-10
decision-makers: Platform
consulted: Product, Fachbereich
informed: everyone who ships to this repo
---

# PostHog is the product platform, and Langfuse feeds it the LLM traces

## Context and Problem Statement

What we learn about Piloti is spread across five places, and none of them joins
to the others:

* **LLM traces, scores and the review queue** are in self-hosted Langfuse
  (ADR-0044, ADR-0089). It answers "what did the model do", not "who was the user,
  what did they do before and after, did they come back".
* **Product analytics** is `posthog-js` in the browser with fifteen events and no
  server side. It is switched off in both stacks: neither `Pulumi.dev.yaml` nor
  `Pulumi.prod.yaml` sets the PostHog keys, and the project has never ingested an
  event.
* **Errors** go through err2issue (ADR-0031): ERROR log records become
  deduplicated GitHub issues. Nothing groups an exception by stack, links it to
  the user's session or to the LLM trace, or alerts on a spike. Python catches
  and logs almost every exception, so most of them never reach it as exceptions.
* **Feedback** is two Postgres tables (answer votes, product feedback). Votes
  are mirrored into Langfuse; product feedback becomes inbox items and GitHub
  issues. There are no surveys, and no support inbox at all.
* **Logs** are visible in the Aspire dashboard (ADR-0029), an in-memory ring
  buffer with no alerting and no retention.

PostHog now covers all of these in one project, on events joined by the same
person. It also offers a loop we cannot build ourselves. In **self-driving**,
scouts and signal sources watch the data, group findings into reports in an
inbox, and an agent opens a pull request against this repository for a human to
review. Every input that loop reads (errors, replays, logs, surveys, insight
anomalies, support conversations) is what this decision puts into PostHog.

Inventory and research behind this record:
[`docs/observability/posthog-migration.md`](../observability/posthog-migration.md).

## Decision Drivers

* **One person, one timeline.** A bad answer, the error it threw, the replay of
  the session and the survey the user filled in must be reachable from each other.
* **Free tier, by design.** The monthly free allowances (1M analytics events,
  100K exceptions, 5K recordings, 1,500 survey responses, 10 GB logs, 1M
  warehouse rows, 3 self-driving PRs) are the budget, not a starting point. Every
  product gets a $0 billing limit, so going over drops data and never bills.
* **Buy, don't build** (AGENTS.md). err2issue, the Aspire pane and a feedback
  triage page are things we wrote because nothing joined them. PostHog does.
* **Keep what Langfuse is good at.** Its trace store, prompt management, score
  configs, annotation queue and judges are built, provisioned as code and tested.
  Moving them would be a second migration with no new capability.
* **Privacy as a default.** Users are planning offices in Austria and Germany,
  handling confidential building documents. The project is on PostHog EU Cloud.
  No email or name is sent, replay masks all text, and the legal copy has to
  stay true.

## Considered Options

* **PostHog as the product platform, with Langfuse feeding it LLM data through
  Langfuse's PostHog integration.**
* PostHog for everything, including LLM traces captured as `$ai_*` events by a
  custom NAT exporter. Langfuse would be retired.
* Status quo: Langfuse plus err2issue plus Aspire, with PostHog switched off.

## Decision Outcome

Chosen option: **PostHog as the product platform, fed LLM data by Langfuse.**
It is the only option that joins the data and keeps what already works.

What goes where:

| Concern | Destination | Path |
|---|---|---|
| LLM traces, generations, spans | Langfuse (store of record) **and** PostHog | Langfuse's PostHog integration exports `langfuse observation` events hourly. Our code emits no `$ai_*` events |
| Runtime scores, user votes, review and judge scores | Langfuse **and** PostHog | Same integration: `langfuse score` events |
| Session ↔ trace | PostHog | The browser's PostHog session id rides the chat turn into trace metadata `$posthog_session_id`, which the integration maps to `$session_id` |
| Product analytics | PostHog | `posthog-js` (browser), `posthog-node` (BFF) |
| Exceptions | PostHog error tracking | Browser autocapture, BFF `onRequestError`, and a Python logging handler for caught-and-logged exceptions. err2issue (ADR-0031) is deleted |
| Logs | PostHog Logs (WARN and above) | An exporter on the existing collector, on by default. The Aspire dashboard (ADR-0029) is deleted; the collector stays, and traces are read in Langfuse |
| Where it is on | Every Pulumi stack, staging and production | The host and the public project token are the program's defaults, so no stack has to opt in; an event's `environment` tells the stacks apart, and an empty `posthogHost` opts one out |
| Surveys | PostHog Surveys | Defined in PostHog; votes on answers keep their own UI |
| Support | PostHog Support (`posthog.conversations`) | The product-feedback dialog also opens a support conversation |
| Alerts | PostHog | Error-tracking, log and insight alerts |
| Self-driving | PostHog inbox | Scouts start in dry run; GitHub integration limited to this repository; PRs reviewed like any other |
| Identity, authorization, feature entitlements | WorkOS (ADR-0002) | Unchanged. PostHog flags are rollout switches, never authorization |

### Consequences

* Good, because a session, its errors, its LLM observations and its feedback
  share one distinct id (the WorkOS user id) and can be read side by side.
* Good, because error tracking groups by stack, links to the LLM trace through
  the trace id, and gets assignment, alerts and the self-driving error source.
  err2issue has none of these.
* Good, because Langfuse keeps doing the job it is configured and tested for.
  Nothing in `langfuse_scores.py`, the catalog or the provisioning moves.
* Good, because the self-driving loop gets real inputs: errors, replays, logs,
  survey answers, support conversations and insight anomalies.
* Bad, because LLM data in PostHog is product-analytics events, not `$ai_*`
  events. PostHog's AI-observability views (trace tree, playground, PostHog
  evaluations, trace reviews) and the `ai-observability` scout do not see it.
  Charts on `langfuse observation`/`langfuse score` work, and so does the
  `anomaly-detection` scout on those charts.
* Bad, because the export is hourly with no backfill, and each observation is one
  analytics event. Turn volume times observations per turn has to stay under 1M
  events a month, together with everything else.
* Bad, because a third party now receives behavioural data and masked session
  recordings. That needs PostHog's DPA and a notice to the customer
  organizations that a sub-processor was added. The privacy notice and the
  landing site's copy now name PostHog, the cookie and the opt-out; they rest on
  legitimate interest without a consent banner, which counsel should confirm.
* Bad, because the live in-memory pane is gone with Aspire: INFO logs are read
  with `kubectl logs`, and the OTel meters (`grid.queue.*`, `grid.provider.*`)
  have no sink until one is chosen.
* Bad, because some PostHog AI features (PostHog AI, Replay Vision, self-driving
  agents) run inference with US model providers whatever the project region.
  They need the organization's AI-data-processing consent, which is a business
  decision, not a setting.

### Confirmation

* `tests/test_posthog_boundaries.py` (in `task be:test`) fails if any module
  other than `posthog_client.py` imports the Python SDK, any module other than
  `posthog-server.ts` imports `posthog-node`, or any module other than
  `lib/analytics/posthog.ts` imports `posthog-js`.
* The same test fails if any code under `src/`, `sources/`, `scripts/`,
  `frontends/aiq_api/src` or `frontends/ui` names one of PostHog's
  AI-observability events (`$ai_generation`, `$ai_trace`, `$ai_span`,
  `$ai_embedding`, `$ai_metric`, `$ai_feedback`). LLM data reaches PostHog only
  through Langfuse.
* $0 billing limits are an organization setting in PostHog, and nothing in this
  repository can see them. The checklist in the migration plan records who set
  them. Review is the only gate there.

## Pros and Cons of the Options

### PostHog for everything, LLM traces as `$ai_*` events

* Good, because PostHog's trace views, evaluations, trace reviews, prompt
  experiments and the `ai-observability` scout would all work.
* Bad, because it means a custom NAT exporter, re-pointing 20 scores, the
  annotation queue, three judges, a dataset and prompt management, and
  rewriting the tests that pin them. That is a full migration of a working system.
* Bad, because 100K AI-observability events a month is tighter than 1M
  analytics events, and LLM content would leave our cluster per call.
* Bad, because it was not what the owner chose: LLM data goes to PostHog through
  Langfuse.

### Status quo

* Good, because nothing changes and nothing leaves our infrastructure.
* Bad, because none of the questions in the context can be answered, and err2issue
  stays the error tracker.

## More Information

* Supersedes ADR-0031 (err2issue) and ADR-0029 (the Aspire dashboard; the OTel
  collector it introduced stays, feeding Langfuse and PostHog Logs). Amends
  ADR-0089: Langfuse stays the LLM observability store, and PostHog becomes where
  LLM data is joined with everything else.
* ADR-0007 (no local identity sync) is untouched. PostHog's WorkOS warehouse
  source is a read-only copy in PostHog for analysis, not a mirror our code reads.
  Whether to connect it is in the migration plan.
* Amended by ADR-0118: the BFF, not the browser, opens a Support ticket for
  every product-feedback report, and PostHog Support is where it is triaged.
