-- 0193: which documents a Skizze has ever been traced over (S6, ADR-0150).
--
-- ## What was missing
--
-- A Skizze traced over a PDF page carries that page in its filed SVG and PDF,
-- in every Fassung. The folder rule (a Skizze lies in its base's restricted
-- folder) was checked against the scene of the CURRENT Fassung only: a save
-- that changed or removed the underlay left earlier Fassungen, and an open
-- draft, holding a page the next move no longer asked about. And moving the
-- BASE into a narrower folder asked nothing at all.
--
-- ## The table
--
-- One row per (Skizze, base document) the Skizze has ever been traced over,
-- written when it is started on a page and on every save whose scene holds an
-- underlay, and never cleared while both documents exist: a Fassung keeps its
-- page as long as the Skizze keeps its history. A move of the Skizze, of the
-- PDF beside it, or of a base checks these rows (`sketch-underlay-register.ts`).
--
--   - both ends are documents of the row's organization, by the composite key
--     `documents (id, organization_id)` (0185), so a row cannot name another
--     tenant's document; a hard delete of either removes the row;
--   - a Skizze is never traced over itself (`…_not_self`).
--
-- ## RLS
--
-- `secure_table` on the organization, as every tenant table.

CREATE TABLE IF NOT EXISTS "sketch_underlay_bases" (
  "organization_id" text NOT NULL,
  "sketch_document_id" uuid NOT NULL,
  "base_document_id" uuid NOT NULL,
  "first_traced_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT sketch_underlay_bases_pkey PRIMARY KEY ("sketch_document_id", "base_document_id"),
  CONSTRAINT sketch_underlay_bases_not_self CHECK ("sketch_document_id" <> "base_document_id"),
  CONSTRAINT sketch_underlay_bases_org_bounded CHECK (char_length("organization_id") BETWEEN 1 AND 255),
  CONSTRAINT sketch_underlay_bases_sketch_tenant_fkey FOREIGN KEY ("sketch_document_id", "organization_id")
    REFERENCES "documents" ("id", "organization_id") ON DELETE CASCADE,
  CONSTRAINT sketch_underlay_bases_base_tenant_fkey FOREIGN KEY ("base_document_id", "organization_id")
    REFERENCES "documents" ("id", "organization_id") ON DELETE CASCADE
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "sketch_underlay_bases_org_base_idx" ON "sketch_underlay_bases" ("organization_id", "base_document_id");
--> statement-breakpoint
SELECT secure_table('sketch_underlay_bases', 'organization_id = current_org()');
