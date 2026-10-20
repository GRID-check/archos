/**
 * INTERNAL export — the usage ledger and every organization's budget limits to
 * PostHog (`lib/analytics/usage-export.ts`, docs/observability/org-spend-in-posthog.md).
 * Called by the job scheduler's clock every ten minutes (`scheduler/index.js`,
 * `sweepUsageExport`). Each call sends the closed hours after the export's
 * cursor, a bounded window at a time, and this hour's budget snapshots once;
 * a second call in the same hour sends nothing new. Token-guarded; not
 * user-facing. With PostHog unconfigured it reads nothing and says so.
 */

import { internalApiRoute } from '@/lib/api/handler'
import { exportUsageToPosthog } from '@/lib/analytics/usage-export'

export const POST = internalApiRoute('PostHog Usage Export', () => exportUsageToPosthog(), {
  tenancy: {
    crossTenant:
      'platform analytics: sums the usage ledger of every organization per hour for PostHog and keeps the ' +
      'export cursor; each organization’s limits and spend for its budget snapshot are read inside withTenant ' +
      'for that organization, under row-level security',
  },
})
