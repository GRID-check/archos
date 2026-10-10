-- 0129: document_fassung_announcements — which new Fassungen have been
-- announced (CONTEXT.md „Fassung"; ADR-0054, ADR-0098).
--
-- `document.new_fassung` is written when a document becomes newer: a person
-- confirms a link, a same-name version is published, or an upload settles
-- after screening (`lib/documents/fassung-notify.ts`). The settle hook runs on
-- every settle, and a re-read („Erneut lesen", the folder brief's bulk re-read,
-- a retry) settles the same document again. Recipients were deduplicated by the
-- inbox row they still held, so a person assigned since, or whose row had aged
-- out, was told about the same Fassung again, months later.
--
-- One row per announced Fassung: the newer document and the anchor the inbox
-- item uses (the new version for a same-name Fassung, the older document for a
-- link). `notifyNewFassung` inserts it before it writes any item, ON CONFLICT DO
-- NOTHING, and writes items only when its insert took the row, so two settles
-- racing on one document announce once. A failed announcement deletes its row,
-- so the next settle tries again.
--
-- The foreign key cascades: a deleted document has nothing left to announce.
-- The anchor has none, because it names a version or another document, either
-- of which may go first, and a missing anchor only means nothing is announced
-- about it again.
CREATE TABLE IF NOT EXISTS "document_fassung_announcements" (
  "organization_id" text NOT NULL,
  "document_id" uuid NOT NULL,
  "anchor_id" uuid NOT NULL,
  "announced_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "document_fassung_announcements_pk" PRIMARY KEY ("document_id", "anchor_id"),
  CONSTRAINT "document_fassung_announcements_document_fkey" FOREIGN KEY ("document_id") REFERENCES "documents"("id") ON DELETE CASCADE
);
--> statement-breakpoint
COMMENT ON TABLE "document_fassung_announcements" IS
  'A new Fassung (document_id, anchor_id) that document.new_fassung has been announced for, once. The settle hook skips what is here, so a re-read tells nobody again.';
--> statement-breakpoint
SELECT grid_secure_table('document_fassung_announcements', 'organization_id = grid_current_org()');
