-- 0186: a person's saved searches, shareable within the office (ADR-0136,
-- docs/design/document-search.md, slice 5).
--
-- ## What was missing
--
-- A search is a question (`lib/search/search-wire.ts`): where to look and what
-- to ask. A person who asks the same one every week ("every current
-- Brandschutzkonzept of the office") had to build it again each time, and could
-- not hand it to a colleague.
--
-- ## The row
--
-- One per saved question. `scope` is the request's query (`SearchScopeQuery`),
-- `query` the body (`SearchBody`) without its cursor: the question, never an
-- answer. Nothing found is stored, so a saved search holds no document, no
-- name of one and no count. `shared` lets every member of the organization
-- see and run it; running it runs as the reader, with the reader's own reach,
-- so sharing a question shares nothing the reader could not already find.
-- A name is unique per owner. Only the owner renames, shares or deletes.
--
-- ## RLS
--
-- A tenant table keyed by its organization. Listed in `rls-coverage.spec.ts`
-- BOUNDARY_MIGRATIONS.

CREATE TABLE IF NOT EXISTS "saved_searches" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "organization_id" text NOT NULL,
  "owner_user_id" text NOT NULL,
  "name" text NOT NULL,
  "scope" jsonb NOT NULL,
  "query" jsonb NOT NULL,
  "shared" boolean DEFAULT false NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT saved_searches_owner_name_key UNIQUE ("organization_id", "owner_user_id", "name"),
  CONSTRAINT saved_searches_name_bounded CHECK (char_length("name") BETWEEN 1 AND 120),
  CONSTRAINT saved_searches_scope_object CHECK (jsonb_typeof("scope") = 'object'),
  CONSTRAINT saved_searches_query_object CHECK (jsonb_typeof("query") = 'object'),
  CONSTRAINT saved_searches_query_bounded CHECK (octet_length("query"::text) < 16000)
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "saved_searches_organization_shared_idx" ON "saved_searches" ("organization_id", "shared");
--> statement-breakpoint
SELECT grid_secure_table('saved_searches', 'organization_id = grid_current_org()');
