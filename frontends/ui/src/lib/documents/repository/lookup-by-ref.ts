/** Resolve a document from an author reference or a live filename. */

import 'server-only'
import { and, desc, eq, inArray, ne } from 'drizzle-orm'
import { getDb } from '@/lib/db'
import { withTenant } from '@/lib/db/tenant-context'
import { documentNameVariants } from '../name-match'
import { documents, type Document, type DocumentAuthor } from '@/lib/db/schema/documents'
import type { DocumentScreeningOutcome } from '@/lib/db/schema/documents'
import { documentVisibleTo, internalRead } from '../visibility'
import { DOCUMENT_LIST_LIMIT } from './list'

/**
 * The document a given reference already filed, if it filed one.
 *
 * The idempotency probe behind `fileGeneratedDocument`. A report is fetched
 * every time its tab is opened, so without this a multi-minute run's single
 * artifact would appear once per re-read — and a duplicate of a report is
 * indistinguishable from a second run's, which is precisely the thing an
 * office cannot untangle later.
 *
 * `authored_by_ref` is the key because it is the one identifier the producer
 * and the row already share — a backend job id for a research run, the answer
 * an artifact was drawn in for a diagram (migration 0066, which renamed the
 * column off the first of those two after it had stopped being the only one).
 * Scoped by organization like every other read here, so a reference guessed from
 * another tenant finds nothing.
 *
 * `authored_by_ref_kind` is deliberately NOT filtered on, and the index does not
 * carry it either. The kind is a function of the producer — the filing path
 * derives one from the other — and the producer is already in the key, so asking
 * for it as well would be a column in the index that this probe does not filter
 * by, which is the index-wider-than-the-probe failure 0064 names.
 *
 * Scoped by PRODUCER since migration 0065, because a run can owe more than one
 * FILE. A diagram is two artifacts that are not substitutes — an SVG that
 * previews and carries its own source, and a PDF that is what gets attached to
 * an Einreichung — and under 0064's key the second call found the first row and
 * answered "already filed", so a diagram could be one or the other and never
 * both. The producer is the right discriminator because that is what a producer
 * has meant since 0063: a KIND OF DELIVERABLE, not a piece of software. A run
 * owes at most one of each kind, which is the rule 0065's index states. The
 * alternative — two synthetic run ids, `{run}:svg` and `{run}:pdf` — needed no
 * migration and was rejected: the column exists so somebody can later ask what
 * wrote a file and in which run, and a key that joins back to no real run is
 * what the schema calls "an audit trail in appearance only".
 *
 * This is the CHEAP half of "once per run", never the guarantee. A lookup cannot
 * see a concurrent caller that has not inserted yet: two report tabs both probe,
 * both miss, and both file. Migration 0065's partial unique index
 * `uniq_documents_authored_ref_producer_per_project` is the half that holds under
 * concurrency, and it is keyed on exactly the four columns this function filters
 * by — `(organization_id, project_id, authored_by_ref, authored_by_producer)`
 * WHERE `authored_by <> 'user'`. THAT AGREEMENT IS LOAD-BEARING IN BOTH DIRECTIONS: a
 * narrower index rejects rows this probe would accept (and the caller's recovery
 * finds no winner to return), a wider one admits duplicates this probe was meant
 * to prevent. Changing the columns here means changing the index in the same
 * commit.
 *
 * Scoped by PROJECT as well, and that is not symmetry for its own sake. The
 * filing target comes from the report request's own `projectId`, so an
 * org-wide probe answered "already filed" for a run whose report went to a
 * DIFFERENT project — handing back the other project's document id and folder,
 * so the second project silently never received the report and the client's
 * Öffnen/Zuweisen actions pointed somewhere the reader may not even be. The
 * probe has to ask the question the caller is actually asking: has this run
 * filed into THIS project.
 */
export async function findDocumentAuthoredByRef(
  ref: string,
  organizationId: string,
  projectId: string,
  producer: string,
): Promise<Pick<Document, 'id' | 'filename' | 'folderId'> | null> {
  const db = getDb()
  const rows = await withTenant({ organizationId }, () =>
    db
      .select({
        id: documents.id,
        filename: documents.filename,
        folderId: documents.folderId,
      })
      .from(documents)
      .where(
        and(
          eq(documents.authoredByRef, ref),
          eq(documents.organizationId, organizationId),
          eq(documents.projectId, projectId),
          eq(documents.authoredByProducer, producer),
          // The index's own predicate, restated. 0064 argues the probe and the
          // index must be the same clause, and until now that agreement held
          // over the KEY COLUMNS only: the index is partial on
          // `authored_by <> 'user'` and the probe filtered on all four columns
          // and no authorship at all — so the probe was WIDER than the rule the
          // index enforces, which is the direction 0064 names as dangerous.
          //
          // What that admits is not hypothetical: 0063's CHECK is one-
          // directional on purpose, so a `user` row MAY carry a producer and a
          // reference (a person saving an artefact a run showed them), and the
          // index is partial precisely so two colleagues doing that do not
          // collide. Such a row would answer this probe. The caller would be
          // told `alreadyFiled` and handed a HUMAN document's id, filename and
          // folder: the report is never filed, and the banner's „Im Projekt
          // öffnen" opens somebody else's upload.
          ne(documents.authoredBy, 'user'),
          // Every row, held or not: the unique index this probe mirrors sees
          // them all, and a published report the gate quarantined is still filed.
          documentVisibleTo(internalRead('identity')),
        ),
      )
      .limit(1),
  )
  return rows[0] ?? null
}

/**
 * Resolve a document's SeaweedFS storage key from its `(collectionName,
 * filename)` pair — the only identity the Python backend carries. Used by the
 * internal document-file lookup (`/api/internal/document-file`), which is
 * service-token guarded, so tenancy relies on the collection name itself
 * (`proj_<uuid>` / `archiv_<orgId>` are unguessable). When the caller can
 * supply one, `organizationId` narrows the row to that org (belt-and-braces
 * for `archiv_` collections); when omitted the lookup stays collection-only.
 * Soft-deleted rows are never returned, and when a filename is re-uploaded
 * into the same collection, the most-recent row wins.
 *
 * ## Machine-authored rows are never resolved here, and that is the invariant
 *
 * `authored_by = 'user'` is not belt-and-braces. This is the second path by
 * which a document's BYTES reach the agent tier, and until it was added it was
 * the open one.
 *
 * The design's safety argument is that a document Piloti wrote is never
 * retrievable by Piloti, enforced by never creating chunks for it —
 * `dispatchDocument` refuses a non-`user` row, and `fileGeneratedDocument`
 * notes that "the safety comes from the dispatch that does not happen, never
 * from this string" about the project collection name it writes. This function
 * is what made that string load-bearing after all: it resolves any
 * `(collection, filename)` pair, and `look` in the knowledge
 * layer calls the internal route with a file name and collection the MODEL
 * supplies, fetches the object, renders a page with pdfium and hands it back
 * as "the actual page the retrieved chunk describes".
 *
 * Two changes turned that from theory into a path. Filing the report as a PDF
 * made it a format that tool renders — a `.docx` was excluded by extension and
 * unrenderable by pdfium — and `generatedFilename` is deterministic
 * (`slug(title)-YYYY-MM-DD.pdf`) from a title that IS the H1 the writer agent
 * wrote. So the model does not have to guess the name of its own filed report;
 * it derived it.
 *
 * Chunk-free was only ever half of "unrepresentable". This is the other half,
 * and it is enforced the same way the dispatcher is: by reading the row, not by
 * trusting the caller.
 */
/**
 * The live document a re-upload of this filename would collide with, if any.
 *
 * A RE-UPLOAD USED TO LEAVE A GHOST. `uploadDocument` minted a fresh id and
 * inserted unconditionally — there is no unique index on (collection, filename)
 * — while the ingest pipeline's `_replace_previous_versions` deletes chunks by
 * filename. So the SECOND upload's chunks replaced the FIRST's, and the first
 * row survived: listed, downloadable, cited by nothing, findable by nothing,
 * and charged to the organization's quota twice.
 *
 * Scoped to one collection — a project's, the Archiv's or a conversation's,
 * all three shelves replace the same way. The comparison is exact, matching `_replace_previous_versions`'
 * own identity rule ("a NEW name is a new document, even when its content
 * supersedes an old one") — a looser match here would let this tier and that
 * one disagree about what the same file is.
 *
 * Only rows a PERSON uploaded. A machine-authored row (`fileGeneratedDocument`)
 * carries a filename the model chose and owns no chunks, so a person dropping a
 * file of the same name is not correcting Piloti's report — and pointing the
 * agent's row at their bytes would leave a human file wearing the agent's
 * authorship. The two coexist; only human uploads replace human uploads.
 *
 * `uniq_documents_live_name_per_collection` (migration 0074, restated by 0077
 * without the never-written `deleted_at`) is this probe's WHERE clause as a
 * constraint, so a concurrent first upload of one name cannot
 * slip past it and recreate the ghost this exists to stop.
 */
export async function findLiveDocumentByFilename(
  organizationId: string,
  collectionName: string,
  filename: string,
): Promise<{
  id: string
  storageKey: string
  storageBucket: string | null
  fileSize: number | null
  contentHash: string | null
  folderId: string | null
  status: string
  authoredBy: DocumentAuthor
  screeningOutcome: DocumentScreeningOutcome | null
  screenedHash: string | null
  createdBy: string
  scope: Document['scope']
  projectId: string | null
} | null> {
  const db = getDb()
  const [row] = await withTenant({ organizationId }, () =>
    db
      .select({
        id: documents.id,
        storageKey: documents.storageKey,
        storageBucket: documents.storageBucket,
        fileSize: documents.fileSize,
        contentHash: documents.contentHash,
        folderId: documents.folderId,
        // What `assertMayReplaceHeld` needs to answer a held row (ADR-0086).
        status: documents.status,
        authoredBy: documents.authoredBy,
        screeningOutcome: documents.screeningOutcome,
        screenedHash: documents.screenedHash,
        createdBy: documents.createdBy,
        scope: documents.scope,
        projectId: documents.projectId,
      })
      .from(documents)
      .where(
        and(
          eq(documents.organizationId, organizationId),
          eq(documents.collectionName, collectionName),
          /*
           * Either Unicode form of the name, not just the one the caller holds.
           *
           * A name off a Mac is decomposed and the same name typed here is
           * composed; they render identically, and `= $1` matches one of them.
           * Rows written since `documentNameKey` reached the upload path are all
           * composed, but the ones written before it are whatever arrived — and
           * a miss here is not a null result, it is a SECOND document under a
           * name a person cannot tell apart from the first.
           *
           * Two exact candidates rather than `normalize(filename, NFC) = $1`,
           * which no index can serve.
           */
          inArray(documents.filename, documentNameVariants(filename)),
          eq(documents.authoredBy, 'user'),
          // Every row, held or not: the unique index refuses a second live
          // name whoever holds the first, and the caller answers a held row
          // its uploader may not see as a taken name (ADR-0086).
          documentVisibleTo(internalRead('identity')),
        ),
      )
      // Newest wins if history already left more than one — this function is
      // also how that history stops growing.
      .orderBy(desc(documents.createdAt))
      .limit(1),
  )
  return row ?? null
}

/**
 * The retrieval collections of this project that already hold a live,
 * person-uploaded document of this name — either Unicode form, as
 * {@link findLiveDocumentByFilename} reads it. A project keeps one document
 * per name across all its collections (ADR-0087); the database only enforces
 * it per collection.
 */
export async function findProjectCollectionsHoldingFilename(
  organizationId: string,
  projectId: string,
  filename: string,
): Promise<string[]> {
  const db = getDb()
  const rows = await withTenant({ organizationId }, () =>
    db
      .selectDistinct({ collectionName: documents.collectionName })
      .from(documents)
      .where(
        and(
          eq(documents.organizationId, organizationId),
          eq(documents.projectId, projectId),
          eq(documents.scope, 'project'),
          inArray(documents.filename, documentNameVariants(filename)),
          eq(documents.authoredBy, 'user'),
          // A held file takes its name too; the upload refuses it without
          // saying whose, as it does a hidden folder's (ADR-0086, ADR-0087).
          documentVisibleTo(internalRead('identity')),
        ),
      )
      .limit(DOCUMENT_LIST_LIMIT),
  )
  return rows.map((row) => row.collectionName)
}
