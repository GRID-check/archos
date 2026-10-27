-- 0185: what a document is, made filterable where its authorization lives
-- (ADR-0133, docs/design/document-search.md).
--
-- ## Why
--
-- Ingestion writes each document's reading (dossier, references, coverage,
-- Plankopf facts, capture) into the agent database, keyed by collection and
-- file name. The BFF merged it onto a listing page after the page was cut, so
-- nothing could filter, sort or count on it. Search needs the filter, the sort,
-- the facet counts and the authorization (shelf, hidden folders, held uploads)
-- in ONE statement, so the filterable part is projected here, beside
-- `documents`.
--
-- ## document_search_facets
--
-- One row per document, derived and never authored: the projector
-- (`lib/search/facets-projector.ts`) replaces a row whole when its document
-- settles, and a shelf's rows when the backstop refresh runs. `fingerprint` is
-- the hash of what it was built from, so an unchanged row is not rewritten.
-- Tokens are lower case: `reference_tokens` are `kind:key` (the Qdrant
-- payload's own `references` tokens), `fact_tokens` are `key=value`
-- (`normalizeFactValue`). `fact_numbers` holds the facts that parse as numbers,
-- for ranges. `search_vector` is generated from `search_text` (title, summary,
-- parties, place, plan number, reference labels, topics), German stemming.
--
-- ## Indexes
--
-- B-tree only, each leading with the organization the RLS policy pins. No GIN
-- on the token arrays or the full-text vector: the runtime role reads this
-- table under row-level security, and the planner never turns a
-- non-leakproof operator (`@>`, `&&`, `@@`, `LIKE`) into an index condition
-- below the policy's qual, so such an index is written on every refresh and
-- read by nobody. Measured on a 60,000-row seed (`search-latency.integration.
-- spec.ts`): the five GIN indexes held about 19 MB and served 0 scans as
-- `grid_app_rw`; every filter on them runs as a filter over the
-- organization's rows, which the search joins to `documents` anyway.
-- `docs/contributing/gotchas.md` has the symptom.
--
-- ## document_search_shelves
--
-- One row per shelf: when its facets were last refreshed, from which
-- fingerprint of its documents (count and newest change), and when a refresh
-- was last queued, so two searches that find it stale queue one job.
--
-- ## RLS
--
-- Tenant tables keyed by their organization. Listed in `rls-coverage.spec.ts`
-- BOUNDARY_MIGRATIONS.

CREATE TABLE IF NOT EXISTS "document_search_facets" (
  "document_id" uuid PRIMARY KEY NOT NULL REFERENCES "documents"("id") ON DELETE CASCADE,
  "organization_id" text NOT NULL,
  "document_type" text,
  "tags" text[] DEFAULT '{}' NOT NULL,
  "topics" text[] DEFAULT '{}' NOT NULL,
  "title" text,
  "summary" text,
  "parties" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "party_roles" text[] DEFAULT '{}' NOT NULL,
  "address" text,
  "municipality" text,
  "federal_state" text,
  "facts" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "fact_tokens" text[] DEFAULT '{}' NOT NULL,
  "fact_numbers" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "reference_tokens" text[] DEFAULT '{}' NOT NULL,
  "reference_labels" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "plan_number" text,
  "plan_number_key" text,
  "plan_index" text,
  "plan_date" date,
  "scale" text,
  "document_date" date,
  "captured_at" timestamp with time zone,
  "camera" text,
  "page_count" integer,
  "pages_not_read" integer,
  "superseded" boolean DEFAULT false NOT NULL,
  "search_text" text DEFAULT '' NOT NULL,
  "search_vector" tsvector GENERATED ALWAYS AS (to_tsvector('german'::regconfig, "search_text")) STORED,
  "fingerprint" text NOT NULL,
  "synced_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT document_search_facets_parties_array CHECK (jsonb_typeof("parties") = 'array'),
  CONSTRAINT document_search_facets_facts_array CHECK (jsonb_typeof("facts") = 'array'),
  CONSTRAINT document_search_facets_numbers_object CHECK (jsonb_typeof("fact_numbers") = 'object'),
  CONSTRAINT document_search_facets_labels_object CHECK (jsonb_typeof("reference_labels") = 'object'),
  CONSTRAINT document_search_facets_text_bounded CHECK (char_length("search_text") <= 20000),
  CONSTRAINT document_search_facets_pages CHECK ("page_count" IS NULL OR "page_count" >= 0),
  CONSTRAINT document_search_facets_unread CHECK ("pages_not_read" IS NULL OR "pages_not_read" >= 0)
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "document_search_facets_org_type_idx" ON "document_search_facets" ("organization_id", "document_type");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "document_search_facets_org_plan_idx" ON "document_search_facets" ("organization_id", "plan_number_key");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "document_search_facets_org_plan_date_idx" ON "document_search_facets" ("organization_id", "plan_date");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "document_search_facets_org_document_date_idx" ON "document_search_facets" ("organization_id", "document_date");
--> statement-breakpoint
SELECT grid_secure_table('document_search_facets', 'organization_id = grid_current_org()');
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "document_search_shelves" (
  "organization_id" text NOT NULL,
  "shelf_key" text NOT NULL,
  "project_id" uuid REFERENCES "projects"("id") ON DELETE CASCADE,
  "source_fingerprint" text,
  "synced_at" timestamp with time zone,
  "refresh_requested_at" timestamp with time zone,
  CONSTRAINT document_search_shelves_pkey PRIMARY KEY ("organization_id", "shelf_key"),
  CONSTRAINT document_search_shelves_key_shape CHECK (
    ("shelf_key" = 'office_shelf' AND "project_id" IS NULL)
    OR ("project_id" IS NOT NULL AND "shelf_key" = 'project:' || "project_id"::text)
  ),
  CONSTRAINT document_search_shelves_synced_together CHECK (("synced_at" IS NULL) = ("source_fingerprint" IS NULL))
);
--> statement-breakpoint
SELECT grid_secure_table('document_search_shelves', 'organization_id = grid_current_org()');
