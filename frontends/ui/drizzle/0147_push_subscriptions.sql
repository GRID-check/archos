-- 0147: push_subscriptions — the devices a person turned notifications on for
-- (Web Push for the inbox; ADR-0112).
--
-- One row per browser installation. The endpoint is the push service's address
-- for it and is unique across the table: a device notifies exactly one person
-- in one organization, the one who registered it last. `lib/push/repository.ts`
-- removes a different person's or organization's row for the endpoint before it
-- writes (a platform-scope DELETE, named and reasoned there), so a shared
-- computer never shows A's notifications to B.
--
-- `p256dh` and `auth` are the subscription's encryption key and secret, which
-- a sender needs to encrypt a payload for this browser. The row holds no
-- notification content, only where to send and how to scramble it.
--
-- The CHECKs bound what a request can store: the endpoint is an https URL, and
-- every text column has a length, so a client cannot park a megabyte in a row.
-- A subscription is removed on the push service's 404 or 410, and after
-- `failure_count` reaches the sender's limit (`lib/push/service.ts`).
--
-- Secured by its own `organization_id`, as `inbox_items` is: the person is a
-- filter the service applies, the organization is the boundary the database
-- keeps.
CREATE TABLE IF NOT EXISTS "push_subscriptions" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "organization_id" text NOT NULL,
  "user_id" text NOT NULL,
  "endpoint" text NOT NULL,
  "p256dh" text NOT NULL,
  "auth" text NOT NULL,
  "device_label" text NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "last_success_at" timestamp with time zone,
  "failure_count" integer DEFAULT 0 NOT NULL,
  CONSTRAINT push_subscriptions_endpoint_https
    CHECK ("endpoint" LIKE 'https://%' AND char_length("endpoint") <= 2048),
  CONSTRAINT push_subscriptions_keys_length
    CHECK (char_length("p256dh") BETWEEN 1 AND 256 AND char_length("auth") BETWEEN 1 AND 256),
  CONSTRAINT push_subscriptions_label_length
    CHECK (char_length("device_label") BETWEEN 1 AND 120),
  CONSTRAINT push_subscriptions_failure_count_nonnegative
    CHECK ("failure_count" >= 0)
);
--> statement-breakpoint
COMMENT ON TABLE "push_subscriptions" IS
  'A browser a person turned inbox notifications on for (Web Push, ADR-0112). endpoint is unique across tenants: a device belongs to whoever registered it last. Holds the encryption key and secret of the subscription, never notification content.';
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uniq_push_subscriptions_endpoint"
  ON "push_subscriptions" ("endpoint");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_push_subscriptions_person"
  ON "push_subscriptions" ("organization_id", "user_id");
--> statement-breakpoint
SELECT grid_secure_table('push_subscriptions', 'organization_id = grid_current_org()');
