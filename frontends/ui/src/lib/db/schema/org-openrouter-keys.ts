import { sql } from 'drizzle-orm'
import { index, numeric, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core'

/**
 * `org_openrouter_keys` — the OpenRouter key the platform provisioned for one
 * organization (migration 0159, ADR-0121). METADATA ONLY, like
 * `org_llm_credentials`: the key itself is in the secret store
 * (`lib/llm-credentials/secret-store.ts`), `vault_object_id` or
 * `encrypted_key` set to match `secret_backend`.
 *
 * Every model call made for the organization goes out on this key unless it is
 * already on the organization's own (BYOK) key; there is no fallback to the
 * deployment's shared key. The key is created through OpenRouter's management
 * API the first time the organization needs one (`lib/llm-credentials/org-keys.ts`),
 * and `openrouter_key_hash` is OpenRouter's handle for it there (update the
 * limit, disable, delete). `limit_usd` is the monthly backstop set on the key
 * when it was created, never the organization's budget, which the ledger keeps.
 *
 * The partial unique index allows at most one ACTIVE key per organization, so
 * two replicas provisioning at once cannot both win; the loser deletes the key
 * it created.
 */
export const orgOpenrouterKeys = pgTable(
  'org_openrouter_keys',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /** WorkOS organization id (text, never an FK — ADR-0007). */
    organizationId: text('organization_id').notNull(),
    /** OpenRouter's `hash` for the key: the management API addresses it by this. */
    openrouterKeyHash: text('openrouter_key_hash').notNull(),
    /** Which secret store holds the key: `workos-vault` | `local-aes-gcm`. */
    secretBackend: text('secret_backend').notNull(),
    vaultObjectId: text('vault_object_id'),
    encryptedKey: text('encrypted_key'),
    /** SHA-256 hex prefix of the key, for logs and forensics; never reversible. */
    keyFingerprint: text('key_fingerprint').notNull(),
    /** The monthly backstop on the key at creation, in USD; NULL = none. */
    limitUsd: numeric('limit_usd'),
    /** `active` | `disabled`. */
    status: text('status').notNull().default('active'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    disabledAt: timestamp('disabled_at', { withTimezone: true }),
  },
  (table) => ({
    activePerOrgUnique: uniqueIndex('uniq_org_openrouter_keys_active')
      .on(table.organizationId)
      .where(sql`${table.status} = 'active'`),
    orgIdx: index('idx_org_openrouter_keys_org').on(table.organizationId, table.createdAt),
  })
)

export type OrgOpenrouterKey = typeof orgOpenrouterKeys.$inferSelect
export type NewOrgOpenrouterKey = typeof orgOpenrouterKeys.$inferInsert
