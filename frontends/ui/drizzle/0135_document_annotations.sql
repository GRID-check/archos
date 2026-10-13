-- 0135: document_annotations and document_annotation_replies — marks people
-- and Piloti set at a place on a page of a document, and the conversation
-- under each (CONTEXT.md „Anmerkung").
--
-- ## What was missing
--
-- An architect reviews a drawing from a Fachplaner, walks a Begehung with the
-- Einreichung in hand, or goes through a sheet with the team in a Jour fixe,
-- and what they find has a PLACE: this door, this stair, this corner of sheet
-- 3. Piloti could show the page and cite a passage on it, but nobody could
-- leave anything there. Findings went into mail, a PDF with red circles that
-- nobody can query, or a defect tool that has never read the project. A mark
-- with a place, a thread, a person and a date is what tools like PlanRadar are
-- built around; here it sits on the document Piloti reads, so Piloti can read
-- the marks and set its own.
--
-- ## The mark
--
-- One row per Anmerkung, on the document (`document_id`, which every
-- citation, assignment and share binds) AND on the Fassung that was shown when
-- it was set (`version_id`). A position is true of the sheet somebody looked
-- at: when a newer Fassung arrives the Anmerkung stays, and the viewer says it
-- was set on an earlier one rather than drawing it over geometry that may have
-- moved (the reasoning 0035 applies to a model revision). `version_id` is NULL
-- for a document without a version row, and becomes NULL if its version is
-- discarded; the Anmerkung outlives it.
--
-- A mark is a POINT (`x`, `y`) or a REGION (`x`, `y`, `w`, `h`): a share of
-- the page as the viewer shows it, top-left origin, the frame `PageRegion`
-- already uses. A region stays on its page.
--
-- `number` is the document's running number („Anmerkung 4"), the handle a
-- Protokoll and a conversation use. Allocated as max + 1 under a per-document
-- advisory lock; the unique index is the backstop.
--
-- ## Who set it, and what Piloti may do
--
-- `author_kind` is `person` or `piloti`. `created_by` is always a person: the
-- one who set it, or the one on whose behalf Piloti worked (the signed
-- request-context envelope's user, ADR-0054 §4). Piloti proposes, a person
-- confirms (VISION.md, principle 4), so Piloti's marks are born `proposed` and
-- only a person moves one to `open` (Übernehmen, `accepted_by`) or `dismissed`
-- (Verwerfen). A person's mark is born `open`. The CHECKs hold both rules, so
-- no code path can publish a machine finding as the office's own.
--
-- `status`: proposed | open | resolved | dismissed. Closing (resolved,
-- dismissed) is by somebody at some time, or it is not a closing: the
-- `tasks_review_complete` shape. `kind` (hint | question | defect: Hinweis,
-- Rückfrage, Mangel) and `status` are plain text with CHECKs naming today's
-- members, as in `tasks` (0075).
--
-- `basis` is what a finding rests on, when it rests on something citable
-- („OIB-RL 2, Pkt. 3.5.2"): Piloti's proposals carry one, a person's may.
--
-- `assignee_user_id` is who is to act on it (Zuständig), an organization
-- member the service checks can reach the document. Not access (ADR-0059).
--
-- ## The thread
--
-- `document_annotation_replies`: the conversation under a mark, in order. A
-- reply is by a person, or by Piloti on a person's behalf, exactly like the
-- mark. It goes with its mark.
--
-- ## RLS
--
-- Both are tenant tables: the organization, AND the document's organization,
-- so a row cannot be planted on another tenant's document. Listed in
-- `rls-coverage.spec.ts` BOUNDARY_MIGRATIONS.

CREATE TABLE IF NOT EXISTS "document_annotations" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "organization_id" text NOT NULL,
  "document_id" uuid NOT NULL,
  "version_id" uuid,
  "number" integer NOT NULL,
  "page" integer NOT NULL,
  "shape" text NOT NULL,
  "x" double precision NOT NULL,
  "y" double precision NOT NULL,
  "w" double precision,
  "h" double precision,
  "kind" text NOT NULL,
  "body" text NOT NULL,
  "basis" text,
  "author_kind" text NOT NULL,
  "status" text NOT NULL,
  "assignee_user_id" text,
  "due_on" date,
  "created_by" text NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  "accepted_by" text,
  "accepted_at" timestamp with time zone,
  "closed_by" text,
  "closed_at" timestamp with time zone,
  CONSTRAINT "document_annotations_document_fkey"
    FOREIGN KEY ("document_id") REFERENCES "documents"("id") ON DELETE CASCADE,
  CONSTRAINT "document_annotations_version_fkey"
    FOREIGN KEY ("version_id") REFERENCES "document_versions"("id") ON DELETE SET NULL,
  CONSTRAINT document_annotations_number_positive CHECK ("number" >= 1),
  CONSTRAINT document_annotations_page_positive CHECK ("page" >= 1),
  CONSTRAINT document_annotations_shape_known CHECK ("shape" IN ('point', 'region')),
  CONSTRAINT document_annotations_point_on_page
    CHECK ("x" >= 0 AND "x" <= 1 AND "y" >= 0 AND "y" <= 1),
  CONSTRAINT document_annotations_region_on_page
    CHECK (
      ("shape" = 'point' AND "w" IS NULL AND "h" IS NULL)
      OR ("shape" = 'region' AND "w" > 0 AND "h" > 0 AND "x" + "w" <= 1.000001 AND "y" + "h" <= 1.000001)
    ),
  CONSTRAINT document_annotations_kind_known
    CHECK ("kind" IN ('hint', 'question', 'defect')),
  CONSTRAINT document_annotations_author_known
    CHECK ("author_kind" IN ('person', 'piloti')),
  CONSTRAINT document_annotations_status_known
    CHECK ("status" IN ('proposed', 'open', 'resolved', 'dismissed')),
  CONSTRAINT document_annotations_only_piloti_proposes
    CHECK ("status" <> 'proposed' OR "author_kind" = 'piloti'),
  CONSTRAINT document_annotations_acceptance_complete
    CHECK (("accepted_by" IS NULL) = ("accepted_at" IS NULL)),
  CONSTRAINT document_annotations_piloti_needs_a_person
    CHECK ("author_kind" = 'person' OR "status" IN ('proposed', 'dismissed') OR "accepted_by" IS NOT NULL),
  CONSTRAINT document_annotations_closing_complete
    CHECK (
      ("status" IN ('resolved', 'dismissed')) = ("closed_by" IS NOT NULL)
      AND ("closed_by" IS NULL) = ("closed_at" IS NULL)
    ),
  CONSTRAINT document_annotations_body_length
    CHECK (char_length(btrim("body")) BETWEEN 1 AND 2000),
  CONSTRAINT document_annotations_basis_length
    CHECK ("basis" IS NULL OR char_length("basis") BETWEEN 1 AND 300)
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uniq_document_annotations_number"
  ON "document_annotations" ("document_id", "number");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_document_annotations_organization_id"
  ON "document_annotations" ("organization_id");
--> statement-breakpoint
SELECT grid_secure_table('document_annotations',
  'organization_id = grid_current_org() AND EXISTS (SELECT 1 FROM documents d WHERE d.id = document_id AND d.organization_id = grid_current_org())');
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "document_annotation_replies" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "organization_id" text NOT NULL,
  "annotation_id" uuid NOT NULL,
  "author_kind" text NOT NULL,
  "body" text NOT NULL,
  "created_by" text NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "document_annotation_replies_annotation_fkey"
    FOREIGN KEY ("annotation_id") REFERENCES "document_annotations"("id") ON DELETE CASCADE,
  CONSTRAINT document_annotation_replies_author_known
    CHECK ("author_kind" IN ('person', 'piloti')),
  CONSTRAINT document_annotation_replies_body_length
    CHECK (char_length(btrim("body")) BETWEEN 1 AND 2000)
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_document_annotation_replies_annotation"
  ON "document_annotation_replies" ("annotation_id", "created_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_document_annotation_replies_organization_id"
  ON "document_annotation_replies" ("organization_id");
--> statement-breakpoint
SELECT grid_secure_table('document_annotation_replies',
  'organization_id = grid_current_org() AND EXISTS (SELECT 1 FROM document_annotations a WHERE a.id = annotation_id AND a.organization_id = grid_current_org())');
