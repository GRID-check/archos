-- 0173: org_openrouter_keys — the OpenRouter key the platform provisions for
-- each organization (ADR-0121).
--
-- ## What was missing
--
-- Every organization's model calls went out on one shared OpenRouter key. A
-- leaked key, a runaway job or a provider's abuse block reached every tenant at
-- once, and nothing could be revoked or read per tenant at OpenRouter. Now each
-- organization gets a key of its own, created through OpenRouter's management
-- API the first time it needs one, and a call made for an organization never
-- goes out on the shared key.
--
-- ## The columns and what holds them
--
-- Metadata only, like `org_llm_credentials` (0016): the key is in WorkOS Vault
-- (`vault_object_id`) or a local AES-256-GCM envelope (`encrypted_key`), and the
-- CHECK holds exactly the column `secret_backend` names. `openrouter_key_hash`
-- is OpenRouter's handle for the key in its management API. `limit_usd` is the
-- monthly backstop set on the key when it was created; the organization's
-- budget stays on the ledger.
--
-- One ACTIVE key per organization (`uniq_org_openrouter_keys_active`): two
-- replicas provisioning at once cannot both insert, and the one that loses
-- deletes the key it created at OpenRouter. A disabled row stays as the record
-- of a key that existed.
--
-- ## RLS
--
-- Secured by its own `organization_id`, as `org_llm_credentials` is.
CREATE TABLE IF NOT EXISTS "org_openrouter_keys" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "organization_id" text NOT NULL,
  "openrouter_key_hash" text NOT NULL,
  "secret_backend" text NOT NULL,
  "vault_object_id" text,
  "encrypted_key" text,
  "key_fingerprint" text NOT NULL,
  "limit_usd" numeric,
  "status" text DEFAULT 'active' NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "disabled_at" timestamp with time zone,
  CONSTRAINT org_openrouter_keys_status_known
    CHECK ("status" IN ('active', 'disabled')),
  CONSTRAINT org_openrouter_keys_secret_matches_backend
    CHECK (
      ("secret_backend" = 'workos-vault' AND "vault_object_id" IS NOT NULL)
      OR ("secret_backend" = 'local-aes-gcm' AND ("encrypted_key" IS NOT NULL OR "status" = 'disabled'))
    ),
  CONSTRAINT org_openrouter_keys_disabled_has_time
    CHECK (("status" = 'disabled') = ("disabled_at" IS NOT NULL)),
  CONSTRAINT org_openrouter_keys_limit_positive
    CHECK ("limit_usd" IS NULL OR "limit_usd" > 0)
);
--> statement-breakpoint
COMMENT ON TABLE "org_openrouter_keys" IS
  'The OpenRouter key the platform provisioned for an organization (ADR-0121). Metadata only; the key is in the secret store. At most one active row per organization.';
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uniq_org_openrouter_keys_active"
  ON "org_openrouter_keys" ("organization_id") WHERE "status" = 'active';
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_org_openrouter_keys_org"
  ON "org_openrouter_keys" ("organization_id", "created_at");
--> statement-breakpoint
SELECT grid_secure_table('org_openrouter_keys', 'organization_id = grid_current_org()');
