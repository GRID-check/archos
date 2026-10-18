import 'server-only'
import { getTenantContext, withTenant } from '@/lib/db/tenant-context'

/**
 * Run an inbox write that follows a domain event, and never let it fail that
 * event.
 *
 * The item tells somebody about work that is already stored, so a failed write
 * costs a missing row, never the reply or the proposal that caused it. The
 * failure is logged under `label` and swallowed. `inbox_items` is behind
 * row-level security, so the write needs a tenant context: a caller that has
 * one (a request, the wake job) keeps it, and one that has none (a worker
 * settling after the fact) gets the event's organization.
 */
export async function bestEffortInbox(
  label: string,
  organizationId: string,
  write: () => Promise<unknown>
): Promise<void> {
  try {
    if (getTenantContext()) await write()
    else await withTenant({ organizationId }, write)
  } catch (cause) {
    console.error(`[inbox] ${label} could not be written:`, cause)
  }
}
