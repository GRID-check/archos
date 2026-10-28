import { index, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core'

import type { ResourceRole, ShareableResourceType } from '@/lib/sharing/sharing-vocabulary'

/**
 * `resource_shares` — the ONE generic table of resource-level access grants
 * (ADR-0032).
 *
 * Sharing is deliberately modelled as **visibility + additive grants**:
 *   - *visibility* is a blanket rule and lives on the shared resource's own row
 *     (e.g. `conversations.visibility`), so the hot read path costs no join;
 *   - *grants* are individual `(person, role)` records and live here, because
 *     they are the part that must be queried in BOTH directions — "who can
 *     reach R" (the authorization check) and "what has been shared with P"
 *     (the inbox, the history list, the badge, on every render).
 *
 * Why not WorkOS FGA, where project roles live? Because "everything shared with
 * me" is FGA's expensive direction, and it sits on a render path. WorkOS stays
 * authoritative for the **container** (project membership); this table is
 * authoritative for **resources inside** it. Full rationale + the trigger for
 * revisiting: ADR-0032.
 *
 * Invariants enforced elsewhere (see `@/lib/sharing/service`):
 *   - a grant may only RAISE access above what visibility already gives — there
 *     is no per-person deny (ADR-0032);
 *   - effective access is additionally gated by same-organization AND container
 *     access, so a grant can never be a back door into a project;
 *   - a resource always keeps at least one `owner`.
 */

export {
  RESOURCE_ROLES,
  RESOURCE_VISIBILITIES,
  SHAREABLE_RESOURCE_TYPES,
  type ResourceRole,
  type ResourceVisibility,
  type ShareableResourceType,
} from '@/lib/sharing/sharing-vocabulary'

export const resourceShares = pgTable(
  'resource_shares',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /** Tenant scope. Never a cross-organization grant (ADR-0007). */
    organizationId: text('organization_id').notNull(),
    resourceType: text('resource_type').$type<ShareableResourceType>().notNull(),
    /**
     * Opaque id of the shared resource. `text` (not `uuid`) because shareable
     * ids are heterogeneous — a conversation id is a client-generated string,
     * a project id is a uuid. No FK for the same reason; cascade cleanup is
     * explicit in the deletion pipeline.
     */
    resourceId: text('resource_id').notNull(),
    /** WorkOS user id the grant is FOR. */
    subjectUserId: text('subject_user_id').notNull(),
    role: text('role').$type<ResourceRole>().notNull(),
    /** WorkOS user id of the actor who created the grant (for the roster's "why"). */
    grantedBy: text('granted_by').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    /** One grant per person per resource; re-sharing is an upsert of the role. */
    subjectUniq: uniqueIndex('uniq_resource_shares_resource_subject').on(
      table.resourceType,
      table.resourceId,
      table.subjectUserId
    ),
    /** "Everything shared with me" — the reverse lookup this table exists for. */
    subjectIdx: index('idx_resource_shares_org_subject').on(
      table.organizationId,
      table.subjectUserId,
      table.resourceType
    ),
    /** The roster of one resource, and the cascade delete on purge. */
    resourceIdx: index('idx_resource_shares_resource').on(table.resourceType, table.resourceId),
  })
)

export type ResourceShare = typeof resourceShares.$inferSelect
export type NewResourceShare = typeof resourceShares.$inferInsert
