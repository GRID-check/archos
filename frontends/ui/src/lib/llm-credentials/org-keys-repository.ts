/**
 * Drizzle access for `org_openrouter_keys` (ADR-0121). The only module that may
 * query the table; tenancy is enforced in every WHERE clause.
 */

import 'server-only'
import { and, eq } from 'drizzle-orm'
import { getDb } from '@/lib/db'
import { orgOpenrouterKeys, type NewOrgOpenrouterKey, type OrgOpenrouterKey } from '@/lib/db/schema'

/** The partial unique index that allows one active key per organization. */
export const ACTIVE_KEY_INDEX = 'uniq_org_openrouter_keys_active'

export async function getActiveOrgKey(organizationId: string): Promise<OrgOpenrouterKey | null> {
  const db = getDb()
  const [row] = await db
    .select()
    .from(orgOpenrouterKeys)
    .where(and(eq(orgOpenrouterKeys.organizationId, organizationId), eq(orgOpenrouterKeys.status, 'active')))
    .limit(1)
  return row ?? null
}

/** Insert an active key. A second active key for the organization fails on {@link ACTIVE_KEY_INDEX}. */
export async function insertActiveOrgKey(values: NewOrgOpenrouterKey): Promise<OrgOpenrouterKey> {
  const db = getDb()
  const [row] = await db
    .insert(orgOpenrouterKeys)
    .values({ ...values, status: 'active' })
    .returning()
  return row
}
