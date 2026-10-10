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

## Staying free

Every product gets a **$0 billing limit** (Organization → Billing → each product
→ Set billing limit). Above the free allowance PostHog then drops data instead of
billing. The allowances, per month:

| Product | Free | What eats it here | Guard |
|---|---|---|---|
| Product analytics | 1M events | Browser events, autocapture, pageviews **and every exported Langfuse observation and score** | Keep autocapture/dead clicks off where noisy. Watch observations per turn × turns |
| Error tracking | 100K exceptions | Browser, BFF, Python | Python handler rate-limits per fingerprint. Suppression rules for known noise |
| Session replay | 5K recordings | Sampled sessions | Off until the legal copy changes. Then `NEXT_PUBLIC_POSTHOG_REPLAY_SAMPLE_RATE` |
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
  `grid-oib:posthogProjectToken`; optionally `grid-oib:posthogLogsEnabled`.
- [ ] **CI secrets** for releases and source maps (see
  [`deployment/environment-variables.md`](../deployment/environment-variables.md)).
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
4. **Retiring err2issue and Aspire.** err2issue goes off by stack key when
   PostHog error tracking is on. Delete it after a release cycle with nothing
   missed. Aspire stays the live pane.
