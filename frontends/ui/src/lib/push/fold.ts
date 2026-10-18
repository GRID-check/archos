/**
 * One notification for a burst of one type's rows for one person (ADR-0112).
 *
 * A row folds its own occurrences already: twenty replies in one thread are one
 * row, and only the job carrying its latest stamp sends (`./inbox-push-job.ts`).
 * Some news comes as many rows at once instead, one per mark: the morning's due
 * reminders (`runDueRemindersSlice` tells each Zuständige once per mark), a
 * carry-all that hands every mark over again on the replacing document, a
 * person handing out marks one after another. Each was a notification of its
 * own. A type whose push policy says `fold` (`lib/inbox/registry.ts`) is told
 * as a burst instead:
 *
 *   - every job of such a type waits {@link BURST_HOLD_MS} (`./enqueue.ts`), so
 *     a burst has arrived before its first row is told;
 *   - a burst is the person's rows of that type, each touched within
 *     {@link BURST_HOLD_MS} of the next ({@link burstOf}), whatever became of
 *     them since: a row read in the middle still links the rows around it.
 *     Only the job of its newest row sends: any other finds a later row within
 *     the hold and leaves it to that one;
 *   - that job tells every row of the burst still news that the person may
 *     still see in one counted notification („4 Anmerkungen für Sie“, „3 heute
 *     oder morgen fällig, 1 überfällig“, `buildFoldedPushMessage`), or the one
 *     row's own words when only one is left. It does so even when its own row
 *     stopped being news before it ran (read, resolved): the earlier rows left
 *     their burst to it, and would otherwise never be told.
 *
 * Bursts are separated by a quiet gap longer than the hold, so a row is in one
 * burst, whose newest row's job sends. One window remains: `updated_at` is the
 * writer's clock, stamped before its transaction commits, so a row stamped a
 * few milliseconds before the newest job reads, and committed after, is not in
 * that read. It then starts a burst of its own that reaches back over the
 * rows already told, and they are told a second time. Each burst's
 * notification carries its own tag (`fold:<type>:<newest row>`), so the second
 * stands beside the first rather than replacing it with a smaller count.
 */

import 'server-only'
import type { InboxItem, InboxItemType } from '@/lib/db/schema'
import { listTouchedOfType } from '@/lib/inbox/repository'
import { BURST_HOLD_MS } from './enqueue'

/** How far back a burst is looked for; a longer burst is told in more than one notification. */
export const FOLD_LOOKBACK_MS = 10 * 60_000

/** The most rows one notification counts; the newest are kept. */
export const FOLD_MAX_ROWS = 50

/** The rows a fold reads about one row: its type's rows for the same person, around it. */
export type BurstRow = Pick<InboxItem, 'id' | 'updatedAt'>

/**
 * The burst `row` belongs to, among `candidates` (the person's rows of its
 * type, `row` itself included or not): `later` when a newer row arrived
 * within the hold, whose job sends for the burst; else the rows before it in
 * the burst, newest first, each within the hold of the one after it. Pure.
 */
export function burstOf<T extends BurstRow>(
  row: BurstRow,
  candidates: readonly T[],
  holdMs: number = BURST_HOLD_MS
): 'later' | T[] {
  const at = row.updatedAt.getTime()
  const others = candidates.filter((candidate) => candidate.id !== row.id)
  if (others.some((candidate) => candidate.updatedAt.getTime() > at && candidate.updatedAt.getTime() - at <= holdMs)) {
    return 'later'
  }
  const earlier = others
    .filter((candidate) => candidate.updatedAt.getTime() <= at)
    .sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime())
  const burst: T[] = []
  let next = at
  for (const candidate of earlier) {
    if (next - candidate.updatedAt.getTime() > holdMs) break
    burst.push(candidate)
    next = candidate.updatedAt.getTime()
  }
  return burst.slice(0, FOLD_MAX_ROWS - 1)
}

/** Read the burst of `row` for its recipient ({@link burstOf}), the rows before it whatever became of them. */
export async function readBurst(row: InboxItem): Promise<'later' | InboxItem[]> {
  const candidates = await listTouchedOfType(
    row.organizationId,
    row.recipientUserId,
    row.type as InboxItemType,
    { from: new Date(row.updatedAt.getTime() - FOLD_LOOKBACK_MS), to: new Date(row.updatedAt.getTime() + BURST_HOLD_MS) },
    FOLD_MAX_ROWS + 1
  )
  return burstOf(row, candidates)
}
