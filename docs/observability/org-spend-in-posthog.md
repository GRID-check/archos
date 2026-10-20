# Organization spend and limits in PostHog

What each office spends on LLM calls, the limits that stop it, and what the
platform pays and bills for it, readable in PostHog beside everything else
([ADR-0100](../adr/0100-posthog-is-the-product-platform-and-langfuse-feeds-it.md)).
Read it before you build a spend chart, before you ask the PostHog MCP a spend
question, and before you change the usage ledger or the budgets.

## Where the numbers come from

The usage ledger (`llm_usage_events`, ADR-0015, ADR-0053) is the one record of
who spent what. Nothing else in PostHog can stand in for it:

| Source already in PostHog | Why it cannot answer "what did this office spend" |
|---|---|
| `langfuse observation` events | No organization on them, and the export is hourly with gaps: 926 observations reached PostHog in the 30 days to 2026-10-20 while OpenRouter logged thousands of calls a day |
| `openrouter_*` warehouse tables | The platform's own bill per model and key. No tenant in it. Good for reconciling, which the dashboard does |
| `budget_threshold_crossed`, `budget_blocked` | Moments, not amounts. They say a limit was reached, not how much was spent |

So the BFF sends the ledger itself. `lib/analytics/usage-export.ts`, asked by
the job scheduler every ten minutes (`POST /api/internal/analytics/usage-export`,
`sweepUsageExport` in `scheduler/index.js`), sends two personless events:

| Event | One per | What it carries |
|---|---|---|
| `llm_usage_hourly` | organization × closed UTC hour × model × activity × purpose × person × project × key | `amount` in the organization's own unit (credits, or tokens on its own key), the number its Budgets page shows; `calls`, the token counts, `credits`, `cost_usd` (what OpenRouter charged), `price_usd` (what the tenant is charged) |
| `organization_budget_snapshot` | organization × UTC hour, for every organization that spent in the last 35 days or set a limit | Its effective limits (the seeded allowance included), today's and this month's spend against them, `day_pct`/`month_pct`, `blocked`, how many member and project limits it set, its name, and this month's calls, tokens, credits, cost and price |

The full property lists are in [`posthog-events.md`](posthog-events.md).

**Why events and not a Postgres warehouse source.** A warehouse source would
copy the tables with their history, but it needs the production database
reachable from PostHog's cloud and a cross-tenant database login stored there,
and it would leave the rules (which unit, which limit applies, what the seeded
allowance is) to be rewritten in SQL, where they drift from `lib/budgets/service.ts`.
The snapshot calls the same functions the Budgets page calls, so PostHog shows
what the office sees.

**Why hourly aggregates and not one event per call.** The calls are thousands a
day; the aggregates are a few hundred. Charts sum them the same way, and the
1M-event free tier stays free.

### Each hour once

PostHog cannot update an event and does not reliably drop a repeated one at read
time, so an hour sent twice is counted twice. The export keeps a cursor per
stream in `analytics_export_cursors` (migration 0154): a run claims the stream
with a ten-minute lease, sends the closed hours after the cursor, waits for
PostHog to accept them (`flush` rejects when it did not), and only then moves the
cursor. A failed run leaves the cursor where it was. An hour counts as closed ten
minutes after it ends, because a ledger row is stamped when its batch's
transaction starts.

**History arrives by itself.** The first run finds no cursor and starts 90 days
back (`BACKFILL_DAYS`), 48 hours per run; while it is behind, the scheduler asks
again on its next tick, so the history is in PostHog within about half an hour
of the first deploy. Budget snapshots have no history: they start at the first
run.

To send the history again (after a fix to the export, say), delete the PostHog
events first, then the stream's row:

```sql
-- as the platform role, on the app database
DELETE FROM analytics_export_cursors WHERE stream = 'posthog_usage_hourly';
```

### Staging and production

Both stacks send to the one PostHog project, and both run `APP_ENV=production`.
Every server event carries `app_host` (`app.piloti.at`, `app.dev.piloti.at`),
from the pinned redirect URI (`serverSuperProperties`). Filter on it; every
chart below does. Before this change server events carried no deployment at all.

## What is in PostHog

Project 269895. Everything carries the tag `spend`.

**Views** (Data warehouse → Views), for SQL and for the MCP:

| View | One row per | Use it for |
|---|---|---|
| `piloti_llm_usage_hourly` | the `llm_usage_hourly` event, flattened, with `day_utc` and `organization_name` | Anything by model, purpose, person or project |
| `piloti_org_spend_daily` | deployment × organization × UTC day | Trends and month totals per organization |
| `piloti_org_budgets` | deployment × organization: the latest snapshot of the last 7 days | Limits, how much of them is used, who is blocked |

**Dashboards:**

- **Spend — alle Organisationen** (`/dashboard/1038205`): this month's cost,
  revenue and active organizations; every organization against its limits; daily
  cost by organization, by model and by purpose; the ledger against OpenRouter's
  own bill; every limit reached or turn refused in the last 30 days.
- **Spend — eine Organisation** (`/dashboard/1038206`): the charts the office
  sees on its own Budgets page, for the organization picked at the top: today
  and this month against the limits, the 30-day trend, the model mix and its
  table, the members, and what the spend was for.

Both take the SQL variables `piloti_deployment` (default `app.piloti.at`) and,
on the second, `piloti_organization`, a list filled from the organizations that
spent in the last 90 days.

**Data catalog** (proposed, waiting for a person to approve them):
`org_llm_spend_month`, `org_budget_utilisation`,
`platform_llm_cost_and_revenue_daily`. An agent asking a spend question finds
them first (`metric-list`), and once approved runs them as the canonical answer.

**Inside Piloti** the same per-organization view is Platform → Übersicht → an
organization's name (`/app/platform/organizations/[id]`, `platform:usage:view`),
drawn with the office's own Budgets components.

## Asking it through the PostHog MCP

The MCP's `exec` tool runs PostHog commands. The questions people ask, and the
call that answers each:

| Question | Call |
|---|---|
| What did each office spend this month? | `call data-catalog-metric-run {"name": "org_llm_spend_month"}`, or `call execute-sql` on `piloti_org_spend_daily` |
| Who is close to their limit, who is blocked? | `call data-catalog-metric-run {"name": "org_budget_utilisation"}` |
| What did the platform pay and bill per day? | `call data-catalog-metric-run {"name": "platform_llm_cost_and_revenue_daily"}` |
| Show me one office's spend | Open dashboard 1038206 and pick the organization, or the SQL below |

SQL for the questions the catalog does not hold (`call execute-sql {"query": "…"}`):

```sql
-- One office, this month, by model, in its own unit (as its Budgets page shows it)
SELECT model, sum(amount) AS amount, sum(calls) AS calls, sum(cost_usd) AS cost_usd
FROM piloti_llm_usage_hourly
WHERE app_host = 'app.piloti.at'
  AND organization_name ILIKE '%feld72%'
  AND day_utc >= toStartOfMonth(toDate(toTimeZone(now(), 'UTC')))
GROUP BY model ORDER BY amount DESC

-- Total spend per month across all offices, production
SELECT toStartOfMonth(day) AS month, sum(cost_usd) AS cost_usd, sum(price_usd) AS price_usd,
       sum(price_usd) - sum(cost_usd) + sum(own_key_cost_usd) AS margin_usd
FROM piloti_org_spend_daily
WHERE app_host = 'app.piloti.at'
GROUP BY month ORDER BY month

-- What the spend was for (chat answers, ingestion, dictation, helper roles), last 7 days
SELECT activity, purpose, sum(cost_usd) AS cost_usd, sum(calls) AS calls
FROM piloti_llm_usage_hourly
WHERE app_host = 'app.piloti.at' AND day_utc >= today() - 7
GROUP BY activity, purpose ORDER BY cost_usd DESC

-- Biggest spenders by person this month, named from the WorkOS warehouse copy (production only)
SELECT coalesce(u.email, h.user_id) AS person, h.organization_name, sum(h.cost_usd) AS cost_usd
FROM piloti_llm_usage_hourly AS h
LEFT JOIN workos_users AS u ON u.id = h.user_id
WHERE h.app_host = 'app.piloti.at'
  AND h.day_utc >= toStartOfMonth(toDate(toTimeZone(now(), 'UTC')))
GROUP BY person, h.organization_name ORDER BY cost_usd DESC LIMIT 20
```

Rules the numbers follow, so an answer is read right:

- **Days and months are UTC**, as the app enforces budgets. PostHog's own date
  pickers use the project's zone (Europe/Vienna); the views carry `day_utc`.
- **`amount` is in the organization's current unit.** An office that moved to
  its own key reads its whole history in tokens, as its Budgets page does.
  For money, use `credits`, `cost_usd` or `price_usd`.
- **Dictation is in the ledger and in `amount`, but `billed` is false**: no budget
  counts it, and its `credits` are 0. `cost_usd` still carries what it cost.
- **The latest hour is up to 70 minutes behind**; the snapshot is up to an hour
  old. The Budgets page in Piloti is live.

## Changing it

| When you | Also change |
|---|---|
| Add a column to the ledger that a spend question needs | `sumUsageByHour` and `usageHourProperties`, the row in `posthog-events.md`, and the view `piloti_llm_usage_hourly` |
| Change what a budget counts or how a limit is derived | Nothing here: the snapshot calls `lib/budgets/service.ts`. Check the dashboard's numbers against a Budgets page afterwards |
| Rename a property | Every view, insight and catalog metric that reads it. PostHog keeps the old events under the old name |
