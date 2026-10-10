# Switching to PostHog

The plan, inventory and checklist behind
[ADR-0098](../adr/0098-posthog-is-the-product-platform-and-langfuse-feeds-it.md).
It answers three questions: what moves where, what it costs (nothing, by design),
and what a person still has to click.

The PostHog project is **EU Cloud, project 269895** (`https://eu.posthog.com`,
ingestion `https://eu.i.posthog.com`).

## What goes where

| Today | Where it goes | How | State |
|---|---|---|---|
| LLM traces in Langfuse (NAT spans, the 7 direct routes, `retrieve.*`, `decide.*`) | Stay in Langfuse **and** reach PostHog as `langfuse observation` events | Langfuse's PostHog integration, hourly, no backfill. Our code emits no `$ai_*` events (`tests/test_posthog_boundaries.py`) | Integration to enable, see [checklist](#checklist) |
| 20 Langfuse scores (`SCORE_DEFINITIONS`), user votes, review and judge scores | Stay in Langfuse **and** reach PostHog as `langfuse score` events | Same integration | Same |
| Session ↔ trace | PostHog `$session_id` on the exported observations | Browser session id → chat turn → trace metadata `$posthog_session_id` | Code in this change |
| Browser analytics (15 events, off in both stacks) | PostHog product analytics | `posthog-js`, identify by WorkOS user id only, `organization_id` as a property | Code in this change; stack keys to set |
| Server-side events | PostHog | `posthog-node` behind `lib/analytics/posthog-server.ts` | Code in this change |
| err2issue (ERROR logs → GitHub issues) | PostHog error tracking | Browser autocapture, BFF `onRequestError`, Python logging handler (caught-and-logged exceptions), source maps per release | Code in this change; err2issue switched off by stack key |
| Aspire log pane | Stays the live pane; WARN+ logs also go to PostHog Logs | Second exporter on the collector, behind `grid-oib:posthogLogsEnabled` | Code in this change |
| Product feedback dialog (Postgres, inbox, GitHub issues) | Unchanged, and also a PostHog Support conversation | `posthog.conversations.sendMessage` | Code in this change |
| No surveys | PostHog Surveys (NPS, CSAT, churn), German first | Defined in PostHog | Drafts created, not launched |
| No alerts | PostHog alerts on errors, logs and insights | Defined in PostHog | Created in the project |
| No release markers | PostHog annotations and error-tracking releases per deploy | `deploy.yml` steps, skipped without the secret | Code in this change |
| WorkOS users and organizations | PostHog data warehouse (read-only copy, for analysis) | PostHog's WorkOS source (needs a WorkOS API key) | Decision open, see below |
| Feature entitlements, authorization | WorkOS (unchanged) | — | Flags in PostHog are rollout switches, never authorization |

## What is already configured in PostHog

Project 269895 was set up as staging on 2026-10-10 (annotation "PostHog setup
started"). Changing any of it is a click in PostHog. Nothing here is code.

| Area | State |
|---|---|
| Project | "Piloti (staging)", Europe/Vienna, IPs anonymized. On: exception autocapture, web vitals, surveys, heatmaps, Support. Off: dead clicks, console-log and network capture, the session-recording switch (masking pre-set: all inputs, all text, minimum 2 s) |
| Error tracking | Suppression rule for Node deprecation warnings (sampled 0.95). Alerts not created: no destination is connected |
| Logs | Draft alert, disabled, no destination: error/fatal above 20 in 15 minutes |
| Self-driving | 28 scout configs synced. anomaly-detection, web-vitals, surveys, logs, conversations, general and inbox-validation run daily in dry run (`emit=false`). pr-follow-up, error-tracking and ai-observability are off. Inbox sources: error-tracking issue created/reopened/spiking on, session-replay clusters off (sample 0.1) |
| Surveys (drafts, not launched) | NPS (German, 90-day wait, cap 400), CSAT on `report_exported` (cap 300), churn form (hosted link, cap 150) |
| Analytics | 9 actions (one per product event), cohorts "Aktive Nutzer 30T" and "Power users", dashboards "Product — Activation & usage", "LLM — via Langfuse", "Quality & errors" |

Two of these wait on data that nothing sends yet. The NPS audience is the person
property `chat_messages_30d >= 10`, because PostHog refuses behavioural cohorts
for survey targeting. Survey texts are German only until translations are added.

## Staying free

Every product gets a **$0 billing limit** (Organization → Billing → each product
→ Set billing limit). Above the free allowance PostHog then drops data instead of
billing. The allowances, per month:

| Product | Free | What eats it here | Guard |
|---|---|---|---|
| Product analytics | 1M events | Browser events, autocapture, pageviews **and every exported Langfuse observation and score** | Autocapture, dead clicks, heatmaps and `history_change` pageviews are on (wave 2). Watch observations per turn × turns; the lever is the browser, not Langfuse |
| Error tracking | 100K exceptions | Browser, BFF, Python | Python handler rate-limits per fingerprint. Suppression rules for known noise |
| Session replay | 5K recordings | Every session by default (`NEXT_PUBLIC_POSTHOG_SESSION_REPLAY` on, sample rate 1) | Text stays masked. Lower `NEXT_PUBLIC_POSTHOG_REPLAY_SAMPLE_RATE` when a busy office approaches 5K a month |
| Surveys | 1,500 responses | NPS, CSAT, churn | Wait periods and sampling on every survey |
| Logs | 10 GB | WARN and above only | Collector filter drops below WARN |
| Data warehouse | 1M rows | WorkOS source (full refresh each sync) | Daily sync, not hourly |
| AI observability | 100K events | Nothing (we send no `$ai_*`) | — |
| Self-driving inbox | 3 PRs | Implementation PRs | Scouts start in dry run |
| PostHog AI, Replay Vision | 500 / 2,500 credits | Manual use | — |

Group analytics is a paid add-on, so tenancy travels as the `organization_id`
property rather than as a PostHog group.

## Checklist

What only a person with the right account can do. Tick it in the PR, with the
date.

- [ ] **Billing limits $0** on every product (organization owner). The PostHog API
  exposes no billing write.
- [ ] **AI data processing** consent for the organization (needed by self-driving,
  PostHog AI, Replay Vision). This sends data to US model providers. It is a
  business decision first.
- [ ] **GitHub integration**, limited to `grid-check/grid-oib-agent` (Project
  settings → Integrations → GitHub), and each person who ships PRs connects a
  personal GitHub account.
- [ ] **Self-driving custom instructions**: base branch `develop`, Conventional
  Commit titles, `task release:note` for customer-visible changes, read
  `AGENTS.md` first.
- [ ] **Langfuse → PostHog integration**: in Langfuse, Settings → Integrations →
  PostHog, host `https://eu.i.posthog.com`, the project token, export source
  *Enriched observations*, enabled. See [`langfuse.md`](langfuse.md#posthog-export).
- [ ] **Stack keys** on the stacks that should send: `grid-oib:posthogHost`,
  `grid-oib:posthogProjectToken`; optionally `grid-oib:posthogLogsEnabled`,
  `grid-oib:posthogSessionReplay`, `grid-oib:posthogReplaySampleRate`.
- [ ] **An alert destination**: connect GitHub, Slack or a webhook (Project
  settings → Integrations), then create the two error-tracking alerts (issue
  created, issue spiking; the free tier allows two) and attach the draft log
  alert. With GitHub connected, the GitHub alert template does what err2issue
  does today: one issue per new error group.
- [ ] **CI secret and variable** for releases and source maps: repository secret
  `POSTHOG_CLI_API_KEY` (personal API key, scopes `error_tracking:write`,
  `organization:read`, `annotation:write`) and repository variable
  `POSTHOG_PROJECT_ID=269895` ([`contributing/ci.md`](../contributing/ci.md)).
- [ ] **Turn the scouts on**: once consent and GitHub are in place, set the dry-run
  scouts to write to the inbox (`emit`) one at a time, and turn on pr-follow-up.
- [ ] **Survey translations** (English) and launch, after the events they target
  arrive.
- [ ] **Legal copy** before replay or the landing site is instrumented:
  `frontends/ui/src/lib/legal/content/{de,en}.ts`, `frontends/web/src/i18n/ui.ts`,
  and PostHog's DPA signed.
- [ ] **WorkOS source** (if decided): Data pipeline → Sources → WorkOS, a
  read-only WorkOS API key, tables `organizations`, `users`, daily.

## Open decisions

1. **Replay.** It needs the legal copy changed and a consent decision. Until then
   it ships off, with all text masked and document viewers blocked once on.
2. **Langfuse export volume.** Enriched export sends every observation type.
   If observations per turn × turns approaches 1M a month, keep the PostHog
   charts on scores and generations and ask Langfuse for a narrower export
   source.
3. **WorkOS in PostHog.** The warehouse source gives seat and org charts. It is a
   second copy of identity data (ADR-0007 forbids one in *our* database, not in
   an analysis tool). A WorkOS webhook into a PostHog workflow would add login and
   membership events. Both need a WorkOS API key or endpoint secret, which only
   a person creates.
4. **Feedback text in PostHog.** A vote's comment and expected answer are
   written into the Langfuse `user-feedback` score, so the integration copies
   them into PostHog (`langfuse_score_comment`, `langfuse_score_metadata`). There
   they sit outside the Langfuse retention sweep and the chat-erasure workers.
   Either stop writing free text into the score and keep it in Postgres, or add
   PostHog person and event deletion to the erasure pipeline.
5. **Replay link needs two flags.** The browser's session id only reaches the
   trace with `GRID_WIRE_V2_ADDITIVE_FIELDS` on (the hello withholds `accepts`
   otherwise) and `GRID_TRACE_IDENTITY_ATTRIBUTES` on.
6. **Support replies.** A feedback report opens a PostHog Support ticket, but
   replies are visible to the member only through PostHog's own widget, which
   adds its own bubble. The alternative is an in-app "Antworten vom Support" view
   on `posthog.conversations.getTickets`/`getMessages`, which is not built.
7. **Browser storage.** Persistence is `localStorage+cookie` (cross-subdomain),
   so the anonymous id and session survive the WorkOS redirect and a reload. The
   privacy notice names the `ph_<token>_posthog` cookie and entry and the survey
   keys (`seenSurvey_*`). The profile page's "usage analytics" switch calls
   `posthog.opt_out_capturing()` for that browser. Changing `persistence` or
   what is stored is a change to the notice: one commit.
8. **Retiring err2issue and Aspire.** err2issue goes off by stack key when
   PostHog error tracking is on. Delete it after a release cycle with nothing
   missed. Aspire stays the live pane.

## Browser signal (wave 2)

- **First-party ingestion.** `api_host` is `/ingest` (`app/ingest/[...path]/route.ts`,
  `lib/analytics/posthog-proxy.ts`), which relays to `NEXT_PUBLIC_POSTHOG_HOST`
  at runtime and to the `*-assets` host for `/static/*` and `/array/*`. It is
  `publicApiRoute`, outside the auth proxy matcher, forwards an allow-list of
  headers (never cookies) and needs `skipTrailingSlashRedirect`. Switch off with
  `NEXT_PUBLIC_POSTHOG_PROXY=false`.
- **Identity.** The root layout hands the signed-in WorkOS user id to the SDK as
  `bootstrap`, so the first pageview is identified. Super properties on every
  event: `organization_id`, `organization_name`, `user_role`, `locale`. No email
  or name.
- **Secrets never leave.** `before_send` removes `sig|token|secret|key|code|state`
  from every URL-shaped property (`lib/analytics/posthog-scrub.ts`). The BYOK key
  input carries `ph-no-capture`. Replay records headers minus credentials and
  `x-grid-*`, and bodies only for failed requests outside the credentials,
  internal, auth and audit-portal endpoints.
- **Events** (browser): `answer_completed` (`outcome`, `duration_ms`,
  `citation_count`, `source_kinds`, `effort`, `has_run`), `citation_opened`,
  `document_opened`, `ifc_model_opened`, and `answer_feedback_submitted` now
  with `message_id` and `conversation_id`.
