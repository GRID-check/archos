/**
 * Uploading a document and dispatching its processing: the ingest, the BIM extraction or the
 * rendition, queued on `bff_job_queue`.
 */

import 'server-only'
import type { AuthorizedSession } from '@/lib/auth/types'
import type { Document } from '@/lib/db/schema/documents'
import { projectShelf } from './shelf'
import { uploadToShelf, type UploadDocumentResult } from './shelf-upload'
import { findDocumentInOrg, markDocumentNotIndexed, markDocumentIngestFailed, markDocumentProcessing, setDocumentBackgroundJob } from './repository'
import { withTenant } from '@/lib/db/tenant-context'
import { enqueueJob } from '@/lib/jobs-queue/enqueue'
import { findOpenJobId } from '@/lib/jobs-queue/repository'
import { BFF_JOB_PRIORITY, type BffJobPriority } from '@/lib/jobs-queue/types'
import { internalRead } from './document-reader'
import { isIfcFilename } from '@/lib/bim/types'
import { extractsFromRendition, isRenditionEnabled } from './rendition'
import { servedAsRendition } from './document-delivery'
import { type AgentDocumentProvenance, INGEST_DISPATCH_FAILED_MESSAGE, type IngestPriority, RENDITION_REQUIRED_MESSAGE, dispatchIngest } from './ingest-dispatch'

export interface UploadDocumentInput {
  projectId: string
  folderId: string | null
  file: File
  /**
   * Where the file sat before it was uploaded, when the browser knows — a
   * folder upload reports `webkitRelativePath`. Absent for a picked file.
   * Recorded once (migration 0072) and never rewritten; see the schema comment
   * for why this is not Piloti's own folder path.
   */
  originPath?: string | null
  /**
   * The uploader released this file in the upload dialog although the
   * organization's name screening excludes it (ADR-0086) — the Bauvertrag in a
   * folder called „Verträge". Honoured and audited; absent means "do not
   * override", so a client that never asks is screened.
   */
  screeningRelease?: boolean
  /**
   * The upload gesture this file belongs to (migration 0110), as the browser
   * opened it. Recorded on the row when it is the uploader's own open batch
   * for this project; anything else is ignored rather than refused.
   */
  uploadBatchId?: string | null
  /** See `ShelfUploadInput.revisionOf`: the document this is filed as the new Fassung of. */
  revisionOf?: string | null
  /** See `ShelfUploadInput.priority`: `bulk` for a machine filing on a person's behalf. */
  priority?: IngestPriority
}

export type { UploadDocumentResult }

/**
 * Store an uploaded file in SeaweedFS, record it, and hand it to the backend for
 * ingestion — the project's name for the shelf-parameterised pipeline in
 * `./shelf-upload`, which the Archiv shares. Requires `project:documents:write`
 * (or `project:edit`) on the project.
 */
export function uploadDocument(
  session: AuthorizedSession,
  input: UploadDocumentInput,
  request: Request
): Promise<UploadDocumentResult> {
  return uploadToShelf(session, projectShelf(input.projectId), input, request)
}

export interface BeginModelExtractionInput {
  organizationId: string
  projectId: string | null
  documentId: string
  filename: string
  storageKey: string
  storageBucket: string | null
  collectionName: string
  /**
   * Materialised folder path the document is filed under, or `null`/absent for
   * the project root. Travels to the backend as `folder_path` (ADR-0049) so
   * surfacing and retrieval can see the filing; the Archiv and session shelves
   * have no folders and simply omit it.
   */
  folderPath?: string | null
  /** See {@link DispatchIngestExtras.priority}. Set by the reindex and rescan jobs. */
  priority?: IngestPriority
}

/**
 * What a stored object needs before anything can be started for it.
 *
 * `BeginModelExtractionInput` plus the one field only the ingest branch reads,
 * because the IFC branch is otherwise the one that needs more: `dispatchIngest`
 * uses a strict subset of these fields.
 */
export interface DispatchDocumentInput extends BeginModelExtractionInput {
  /**
   * WHICH VERSION these bytes are — the half of the publish door the row cannot
   * answer on its own (ADR-0054).
   *
   * A machine-authored document is refused unless this names the row's
   * `published_version_id`, so a draft, an in-review version, an
   * approved-but-unpublished one, a superseded one and a rejected one all fail
   * the same check rather than each needing to be listed. Absent means "the
   * caller is not dispatching a particular version", which is every human
   * upload path and every re-index — and which an agent-authored row is refused
   * for, exactly as it was before this door existed.
   */
  versionId?: string | null
  /**
   * The provenance a published Piloti document carries into every chunk
   * (`docs/architecture/agent-document-provenance.md`).
   *
   * Never assembled here: this tier does not know who approved anything. It is
   * built by the `ingestPublished` effect, which is the only caller that has a
   * version row and a directory in hand, and travels verbatim onto the wire so
   * the keys the Python side parses are the keys the BFF wrote.
   */
  provenance?: AgentDocumentProvenance | null
  /**
   * The file name of the older document this upload was filed as the new
   * Fassung of, already checked (`resolveRevisionOf`). Read by the ingest paths
   * only: an IFC model's digest is not the file the row names.
   */
  revisionOf?: string | null
}

export interface DispatchDocumentResult {
  jobId: string | null
  /**
   * `processing` is a detached path: an IFC model ({@link beginModelExtraction})
   * or an office file converting first ({@link beginRenditionIngest}).
   * `quarantined` is a row nothing was dispatched for: it waits on a reviewer
   * (ADR-0086), and only a release sends it on. `stored` is an archived row,
   * which is not read while it is archived.
   */
  status: 'pending' | 'uploaded' | 'failed' | 'processing' | 'quarantined' | 'stored'
}

/**
 * The ONE place that decides what happens to a freshly-stored object: an IFC
 * model is parsed, everything else is ingested.
 *
 * An IFC model must NOT go to the ingestor as-is — its STEP source would be
 * embedded as unreadable noise. It is parsed here instead, and the Markdown
 * digest that parse produces is what gets ingested (see `@/lib/bim/service`).
 *
 * That branch used to be written out at each call site — the project upload,
 * the project re-ingest, and the org-wide Archiv upload — which made "does this
 * caller remember that a model is not a document?" a question every new caller
 * had to be asked. Session uploads are the third shelf (ADR-0047 Phase 2) and
 * would have been the fourth copy. There is one copy now, so a caller cannot
 * forget the branch: it cannot see it.
 */
/**
 * Thrown when something tries to index a document a machine wrote and nobody
 * published.
 *
 * Named and exported so a caller can tell this refusal apart from a backend
 * failure: one is a bug in the caller, the other is an outage.
 */
export class AgentAuthoredDocumentNotIndexableError extends Error {
  constructor(readonly documentId: string) {
    super(
      `document ${documentId} was written by a machine and is not a published version, so it must not be indexed`
    )
    this.name = 'AgentAuthoredDocumentNotIndexableError'
  }
}

export async function dispatchDocument(
  input: DispatchDocumentInput
): Promise<DispatchDocumentResult> {
  /**
   * A document a machine wrote reaches the retrieval index in exactly ONE case,
   * and it is checked HERE, at the one place every ingestion path funnels
   * through, by READING THE ROW rather than by trusting the caller.
   *
   * ## The one case, and why it is a row invariant
   *
   * The rule used to be "human-authored, full stop". ADR-0054 widened it by one
   * clause and no more: an agent-authored row passes when the dispatch names
   * the version the row's `published_version_id` points at. Everything else a
   * version can be — `draft`, `in_review`, `changes_requested`, `approved` but
   * not yet published, `superseded`, `rejected` — fails the SAME comparison
   * rather than being enumerated, so a later state cannot be forgotten here.
   *
   * The clause is worth exactly as much as what stands behind it, and what
   * stands behind it is the database: `document_versions_published_is_approved`
   * refuses a published row with no `approved_by`/`approved_at`, and
   * `uniq_document_versions_published_per_document` refuses a second published
   * version. So `published_version_id` names a version a PERSON approved, and
   * "indexed ⟹ published ⟹ approved by a person" is a chain of constraints
   * rather than a chain of call sites.
   *
   * The version id travels in the input because the row cannot supply it: the
   * question is not "does this document have a published version" but "are
   * these the published version's bytes". A re-index that enumerated documents
   * and re-dispatched them names no version and is refused, which is what keeps
   * „Projekt neu indizieren" from putting a superseded draft back in the index.
   *
   * The invariant used to live in `generated.ts`, which only proved that the
   * FILING path does not ingest. That is a claim about one function; the claim
   * the design actually makes is about the document. `reindexProject` — behind
   * the „Projekt neu indizieren" button in Project Settings — enumerated every
   * document in the project and re-dispatched it, and an agent-authored row
   * passed its guard: `stored` is neither `pending` nor `processing`, and the
   * row carries a real storage key and the project's own collection. One click
   * put Piloti's own report into the corpus it retrieves from, whereupon the
   * status became `completed` and the entire not-citable UI — which derives
   * from `status`, not from `authoredBy` — went green.
   *
   * Reading the row costs one primary-key select on an operation that is about
   * to make an HTTP call to the backend, and it buys an invariant no caller can
   * forget and no caller can lie about. Passing authorship in the input would
   * be cheaper and weaker: the next caller would simply be able to get it
   * wrong, which is exactly what happened.
   */
  const row = await findDocumentInOrg(input.documentId, input.organizationId, internalRead('ingest'))
  // An allow-list on a row that must EXIST. `if (row && …)` read a missing row
  // as permission to ingest, which is the one default this guard was moved here
  // to stop making: the argument for reading the row is "never trust the
  // caller", and treating an absent row as `user` trusts the caller about the
  // only thing left. No caller reaches this without having inserted first, so
  // the refusal costs nothing today; it is what keeps the next one honest.
  if (!row || !mayBeIndexed(row, input.versionId ?? null)) {
    throw new AgentAuthoredDocumentNotIndexableError(input.documentId)
  }
  // A quarantined row (ADR-0086) reaches the index through a reviewer's release
  // and no other way: the release moves it to `uploaded` before it dispatches
  // (`markScreeningReleased`). Every other caller re-reads a whole folder or
  // project — a restore from the Papierkorb, a placement move when a folder's
  // access changes, „Projekt neu indizieren" — and a dispatch sets the row
  // `pending`, which lifted the hold for every reader and screened the bytes
  // again under whatever the rules had become. Asked of the row here, so the
  // next such caller cannot forget it.
  if (row.status === 'quarantined') return { jobId: null, status: 'quarantined' }
  // An archived document has left the working set and answers nothing
  // (`archiveDocument` purged its chunks). A same-name re-upload still versions
  // it, and sending those bytes to the index would make a document nobody can
  // see in the listing answer questions again. It is read when it comes back.
  if (row.lifecycle === 'archived') {
    await markDocumentNotIndexed(row.id, input.organizationId)
    return { jobId: null, status: 'stored' }
  }

  if (isIfcFilename(input.filename)) {
    return beginModelExtraction(input)
  }
  // Decided on the ROW's name and stored type, like the preview route decides
  // what to serve, so a file is indexed from the same PDF a reader is shown.
  if (isRenditionEnabled() && servedAsRendition(row)) {
    return beginRenditionIngest(input, row.filename)
  }
  // Without a converter a Word or presentation file has no source to index
  // from. The file is still stored and downloadable; the row says why it is not
  // citable instead of pretending to be ingested.
  if (servedAsRendition(row) && extractsFromRendition(row.filename)) {
    await markDocumentIngestFailed(input.documentId, input.organizationId, RENDITION_REQUIRED_MESSAGE)
    return { jobId: null, status: 'failed' }
  }
  return dispatchIngest(
    input.documentId,
    input.collectionName,
    input.storageKey,
    input.organizationId,
    input.storageBucket,
    input.folderPath ?? null,
    // The ROW's filename, not the caller's: the join key belongs to the row,
    // and this is the same "never trust the caller" argument the guard above
    // makes about authorship.
    {
      fileName: row.filename,
      provenance: input.provenance ?? null,
      priority: input.priority,
      revisionOf: input.revisionOf ?? null,
    }
  )
}

/**
 * Whether this document, dispatched for this version, may be indexed.
 *
 * Split out of {@link dispatchDocument} so the rule is one expression a reader
 * can hold: a person's document always, a machine's only as its own published
 * version. `dispatch.spec.ts` walks every version state through it.
 */
export function mayBeIndexed(
  row: Pick<Document, 'authoredBy' | 'publishedVersionId'>,
  versionId: string | null
): boolean {
  if (row.authoredBy === 'user') return true
  return Boolean(row.publishedVersionId) && row.publishedVersionId === versionId
}

/**
 * The queue priority of work the way ingestion names it: a person's upload is
 * `interactive` (the default), a reindex or a rescan says `bulk`.
 */
function jobPriorityOf(priority: IngestPriority | undefined): BffJobPriority {
  return BFF_JOB_PRIORITY[priority ?? 'interactive']
}

/** The part of a dispatch every background document job carries. */
function documentWorkPayload(input: DispatchDocumentInput) {
  return {
    projectId: input.projectId,
    documentId: input.documentId,
    filename: input.filename,
    storageKey: input.storageKey,
    storageBucket: input.storageBucket,
    collectionName: input.collectionName,
    folderPath: input.folderPath ?? null,
    versionId: input.versionId ?? null,
    priority: input.priority ?? ('interactive' as const),
  }
}

/**
 * Hand a stored document's background work to the `bff-jobs` pool and say so on
 * the row.
 *
 * The row is `processing` before this is called, so it never reads as a green
 * "Ready" for work nobody has done. The job is the work's only owner from here:
 * it outlives this request and the process that took it, and it is claimed
 * fairly across organizations, so a person's upload waits behind their own
 * office's work at most, never behind another's.
 *
 * A job of this kind already open for the SAME object is returned instead of a
 * second one: a retry, a reindex and the sweep that recovers stranded rows all
 * arrive here for a row that may already be queued. The object's key is part of
 * the match, so a document whose bytes were replaced while the first job
 * waited still gets a job for the new bytes.
 *
 * When the queue cannot be written the row says so and the caller is told
 * `failed`, exactly as a backend that refuses an ingest is. A row left at
 * `processing` with nothing behind it would read as work in progress for good.
 */
async function queueDocumentWork(
  kind: 'bim_extract' | 'office_rendition',
  input: DispatchDocumentInput,
  payload: Record<string, unknown>
): Promise<DispatchDocumentResult> {
  try {
    // The document's own organization, stated: callers reach this from a
    // request, an effect and a sweep, and the queue's policy compares the lane
    // to the tenant.
    await withTenant({ organizationId: input.organizationId }, async () => {
      const matching = { documentId: input.documentId, storageKey: input.storageKey }
      const open = await findOpenJobId({ kind, organizationId: input.organizationId, matching })
      const jobId =
        open ??
        (
          await enqueueJob({
            kind,
            organizationId: input.organizationId,
            priority: jobPriorityOf(input.priority),
            payload,
          })
        ).jobId
      await setDocumentBackgroundJob(input.documentId, input.organizationId, jobId)
    })
    return { jobId: null, status: 'processing' }
  } catch (error) {
    console.warn(
      `[documents] ${kind} could not be queued:`,
      error instanceof Error ? error.message : String(error)
    )
    await markDocumentIngestFailed(input.documentId, input.organizationId, INGEST_DISPATCH_FAILED_MESSAGE).catch(
      () => undefined
    )
    return { jobId: null, status: 'failed' }
  }
}

/**
 * Queue IFC extraction for a stored `.ifc` object and return the same shape
 * `dispatchIngest` does, so the upload path stays one expression.
 *
 * Extraction is a JOB (`bim_extract`), not awaited and not detached in this
 * process. A 60 MB model takes tens of seconds to parse and several times its
 * own size in memory, and the caller is an HTTP request that has already stored
 * the bytes: parsing here would trade a durable upload for a gateway timeout,
 * and parsing on the user-facing pod would put it on the event loop that also
 * proxies chat. The `bff-jobs` pool parses it instead (ADR-0081), bounded by its
 * concurrency and scaled on the queue. The document is marked `processing`
 * first, so the row never renders as a green "Ready" for a model that cannot be
 * opened yet, and every terminal outcome of the job writes the row again
 * ({@link runBimExtractJob}):
 *
 *   - parse succeeded → the digest is dispatched, which sets `pending` + job id
 *   - parse failed    → `failed` with the reason, and a `bim_models` row that
 *                       records the same thing for the model surfaces
 *
 * A restart no longer strands the model at `extracting`: the claim goes back to
 * the queue and the next worker parses it again.
 */
export async function beginModelExtraction(input: BeginModelExtractionInput): Promise<DispatchDocumentResult> {
  await markDocumentProcessing(input.documentId, input.organizationId)
  return queueDocumentWork('bim_extract', input, documentWorkPayload(input))
}

/**
 * Queue the conversion of an office original to its PDF rendition, and the
 * ingest that follows — a JOB (`office_rendition`), like
 * {@link beginModelExtraction} and for the same reason (ADR-0071).
 *
 * The conversion used to be raced against a 20-second wait inside the upload
 * request, because a person was waiting on it and the PDF only fed the
 * thumbnail. Now it also decides what text is indexed, so a deck that took 25
 * seconds would be indexed from a different source than one that took 15 —
 * and a slow conversion would silently index the worse text. As a job the
 * conversion gets its full two minutes and nobody waits on it.
 *
 * Why a job and not a promise in this process: a folder of three hundred office
 * files started three hundred conversions in the upload's pod, queued behind a
 * per-process FIFO of two Gotenberg slots, in front of the fair ingest queue
 * that ADR-0076 made fair. Now the backlog sits in the queue, claimed fairly
 * across organizations, and the fleet runs at most as many conversions as the
 * `bff-jobs` pool is sized for (`deploy/pulumi/src/app/bff-jobs.ts`). The
 * per-process FIFO in `./rendition` stays for the one path where a person IS
 * waiting: the preview and file routes.
 *
 * The row goes to `processing` first, exactly as an IFC model does, so it never
 * renders a green "Ready" before anything was dispatched. Every terminal outcome
 * writes the row again: a dispatch sets `pending` + job id or `failed` itself,
 * and {@link runOfficeRenditionJob} covers anything that throws before it.
 */
export async function beginRenditionIngest(
  input: DispatchDocumentInput,
  fileName: string
): Promise<DispatchDocumentResult> {
  await markDocumentProcessing(input.documentId, input.organizationId)
  return queueDocumentWork('office_rendition', input, {
    ...documentWorkPayload(input),
    fileName,
    provenance: input.provenance ?? null,
    revisionOf: input.revisionOf ?? null,
  })
}
