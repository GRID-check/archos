-- 0180: the folder card, tier 1 of the file tools (ADR-0127).
--
-- ## What was missing
--
-- `list_files` showed a folder as a name and a count. An agent working out
-- where to look had to open documents to learn what a folder is about. A
-- folder card is what a colleague would say standing in front of the shelf: an
-- abstract of at most three sentences and up to eight key facts, each naming
-- the documents it rests on.
--
-- ## Who writes it
--
-- Only the BFF, through `PUT /api/internal/folder-cards`. The Python builder
-- (ADR-0127, S11b) computes the card and sends it; ADR-0003 keeps one writer.
-- The Qdrant folder point derived from a card is rebuildable and holds no state
-- of its own.
--
-- ## Keys and tenancy
--
-- One card per folder (`folder_id` unique). The composite foreign key to
-- `project_folders (id, organization_id, scope)` pins the card to its folder's
-- tenant and shelf, and a folder that is purged takes its card with it. The
-- card is keyed by `folder_id`, not by path, so a rename keeps it.
-- `collection` is the retrieval collection the card's documents live in: a
-- restricted folder is its own collection, and its card lives in that scope
-- (ADR-0088: listing is not use). `input_hash` is the hash of what the card
-- was built from; `abstract_hash` of the abstract, so a regenerated abstract
-- that comes out the same does not rewrite the folder point.
--
-- RLS on the organization, as every tenant table since 0031. Listed in
-- `rls-coverage.spec.ts` BOUNDARY_MIGRATIONS.

CREATE TABLE IF NOT EXISTS "folder_cards" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "organization_id" text NOT NULL,
  "folder_id" uuid NOT NULL,
  "scope" text NOT NULL,
  "collection" text NOT NULL,
  "abstract" text,
  "key_facts" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "input_hash" text NOT NULL,
  "abstract_hash" text,
  "model" text,
  "prompt_version" text,
  "status" text DEFAULT 'stale' NOT NULL,
  "generated_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "folder_cards_folder_key" UNIQUE ("folder_id"),
  CONSTRAINT "folder_cards_folder_fkey"
    FOREIGN KEY ("folder_id", "organization_id", "scope")
    REFERENCES "project_folders"("id", "organization_id", "scope") ON DELETE CASCADE,
  CONSTRAINT "folder_cards_scope_check"
    CHECK ("scope" IN ('project', 'office_shelf')),
  CONSTRAINT "folder_cards_abstract_length"
    CHECK ("abstract" IS NULL OR char_length("abstract") <= 600),
  CONSTRAINT "folder_cards_key_facts_shape"
    CHECK (jsonb_typeof("key_facts") = 'array' AND jsonb_array_length("key_facts") <= 8),
  CONSTRAINT "folder_cards_status_check"
    CHECK ("status" IN ('fresh', 'stale', 'failed'))
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_folder_cards_collection"
  ON "folder_cards" ("organization_id", "collection");
--> statement-breakpoint
SELECT grid_secure_table('folder_cards', 'organization_id = grid_current_org()');
