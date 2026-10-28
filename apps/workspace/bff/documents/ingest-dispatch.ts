/**
 * Asking the Python backend to ingest a document: the request, its priority, and the job reference
 * it hands back.
 *
 * `BACKEND_FETCH_TIMEOUT_MS` bounds every call this domain makes to the backend.
 */

import 'server-only'
import { ingestScreeningFor } from '@/lib/upload-screening/service'
import { GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3'
import { presignForBackend, buildThumbnailStorageKey } from '@/lib/s3'
import { resolveDocumentBucket } from '@/lib/storage/bucket'
import { getBackendUrl } from '@/lib/backend-proxy'
import { projectFactsForIngest } from '@/lib/cross-project/project-facts-mirror'
import { findDocumentInOrg, markDocumentIngestFailed, setDocumentIngestJob } from './repository'
import { internalRead } from './document-reader'

/**
 * Bound every server-side call to the Python backend: an unreachable backend
 * container otherwise hangs the BFF request past Cloudflare's ~100s origin
 * timeout (→ 504). Ingest dispatch is best-effort (a timeout is retried once
 * against the idempotent `/v1/ingest`, and a second one is recorded as a
 * failed ingest); the tag edit is user-blocking (a timeout
 * surfaces as an UpstreamError, same as any other transport failure).
 */
export const BACKEND_FETCH_TIMEOUT_MS = 10_000

/**
 * Stored on the document when the backend ingest dispatch never yielded a job.
 * Persisted server-side (like backend-produced error messages), so it cannot
 * go through the per-user i18n dictionaries.
 */
export const INGEST_DISPATCH_FAILED_MESSAGE = 'Ingestion could not be started'

/**
 * One `POST /v1/ingest`, bounded. `jobId` is null for anything but a job id;
 * `timedOut` says the budget ran out, the one outcome that leaves the backend's
 * side unknown (see {@link dispatchIngest}).
 */
async function requestIngestJob(
  body: string,
  organizationId: string
): Promise<{ jobId: string | null; timedOut: boolean }> {
  try {
    const response = await fetch(`${getBackendUrl()}/v1/ingest`, {
      method: 'POST',
      // Forward the org id so the backend resolves the org's BYOK vision
      // credential + runtime model override for VLM captioning during ingestion.
      headers: { 'Content-Type': 'application/json', 'x-grid-organization-id': organizationId },
      body,
      signal: AbortSignal.timeout(BACKEND_FETCH_TIMEOUT_MS),
    })
    if (!response.ok) return { jobId: null, timedOut: false }
    const result: unknown = await response.json()
    const jobId =
      typeof result === 'object' && result !== null ? (result as { job_id?: unknown }).job_id : null
    return { jobId: typeof jobId === 'string' && jobId ? jobId : null, timedOut: false }
  } catch (error) {
    // Anything else never reached the backend or broke on the way back: the
    // shared failed path applies.
    return { jobId: null, timedOut: isTimeoutError(error) }
  }
}

function isTimeoutError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { name?: unknown }).name === 'TimeoutError'
  )
}

/**
 * How long the presigned URLs handed to an ingest JOB stay valid: `file_ref`,
 * `preview_ref` / `extraction_ref`, and the `thumbnail_upload_url` PUT.
 *
 * The job, not the dispatch request, uses them: `/v1/ingest` queues the work
 * and answers at once, and the backend's worker pool (two workers) reaches a
 * job only when the ones ahead of it finish. A folder upload or a project
 * reindex of a few hundred plan sets queues well past an hour, and a URL that
 * expired in the queue fails the document as `original_download_failed` (or,
 * for the rendition, `office_rendition_required`) although nothing is wrong
 * with it. A day covers any queue this deployment can build; SigV4 caps a
 * presigned URL at seven days.
 *
 * The length is affordable because these URLs never leave the server side:
 * signed with the internal-endpoint client, sent only in the POST body to the
 * backend, which neither stores nor logs them, and never persisted here.
 */
export const INGEST_JOB_REF_TTL_SECONDS = 86_400

/**
 * Why a Word or presentation file was not indexed: its PDF could not be made.
 *
 * Its text is read from the rendition and from nothing else (ADR-0071), so no
 * PDF means no index — said as a failure the reader can retry, never papered
 * over by reading the original a worse way.
 */
export const RENDITION_REQUIRED_MESSAGE = 'The PDF version of this file could not be created'

/**
 * Dispatch a document to the backend ingest API and persist the outcome. The
 * upload and re-ingest paths share this so the success path (status pending +
 * jobId) and the failure path (status failed + errorMessage) stay identical.
 *
 * Best-effort: the file is already durable in SeaweedFS + Postgres. Two outcomes:
 *   - a job id came back  → status pending  (setDocumentIngestJob)
 *   - anything else        → status failed   (markDocumentIngestFailed)
 *
 * The third shape the old code allowed — OK without a job id, row left at its
 * 'uploaded' birth status — is gone on purpose: the backend answers 202 with a
 * `job_id` on every success, so that shape was never a quieter success, and
 * the birth status renders as a green "Ready" the document has not earned.
 */
/**
 * The things only some dispatch callers know.
 *
 * One trailing bag rather than more positionals on a function that already
 * takes six. They arrive in pairs: the join key and provenance from the caller
 * that read the row, the two rendition reads from the office path that
 * converted it.
 */
export interface DispatchIngestExtras {
  /**
   * The `documents.filename` these bytes are known by — the retrieval index's
   * join key. Omitted only where the ingested object is not the row's file.
   */
  fileName?: string | null
  /** Set only for a published Piloti document. */
  provenance?: AgentDocumentProvenance | null
  /**
   * A signed read of the office original's PDF rendition (ADR-0070), for the
   * card thumbnail: the backend cannot rasterise a `.docx`. Set only by
   * {@link beginRenditionIngest}, and only when the conversion succeeded.
   */
  previewRef?: string | null
  /**
   * The same signed read, for TEXT extraction (ADR-0071): the backend indexes
   * the PDF instead of the original iff this is present. Which formats get it is
   * the dispatch's decision (`extractsFromRendition`), never the backend's.
   */
  extractionRef?: string | null
  /**
   * `bulk` for work nobody is waiting on (a reindex, a rescan): inside one
   * organization the backend claims an interactive ingest first (ADR-0081).
   * Absent is interactive, and the field is then not sent at all, so a person's
   * upload is byte for byte what it was before the field existed.
   */
  priority?: IngestPriority
  /**
   * The FILE NAME of the document in this collection that these bytes replace,
   * when a person filed the upload as its new Fassung (ADR-0099). Sent as
   * `revision_of`; once the file has been read, the ingest job writes the link
   * `PUT /v1/collections/{c}/revision-links` writes. Absent for every other dispatch,
   * and then not sent at all.
   */
  revisionOf?: string | null
}

/**
 * The two priorities `POST /v1/ingest` accepts. `ingest-priority-contract.spec.ts`
 * pins this list to the backend's `IngestRequest.priority`.
 */
export const INGEST_PRIORITIES = ['interactive', 'bulk'] as const

export type IngestPriority = (typeof INGEST_PRIORITIES)[number]

/**
 * What a published Piloti document carries into the retrieval index.
 *
 * The four keys are spelled here and parsed in
 * `packages/agent/src/agent/common/provenance.py`; the pair is the whole contract, and a
 * typo on either side is silent — a human document is what an unmarked chunk
 * looks like. So the field names ARE the wire names (snake_case, unlike every
 * other interface in this file) rather than being mapped at the fetch, which is
 * where a rename would go unnoticed.
 *
 * `authored_by` is not optional and has one legal value: this type exists only
 * for documents Piloti wrote, and an absent author is what every human document
 * already sends.
 */
export interface AgentDocumentProvenance {
  authored_by: 'agent'
  /** The DISPLAY NAME of the person who approved it, never their user id. */
  approved_by: string | null
  /** ISO timestamp of that approval. */
  approved_at: string | null
  /** Which pipeline wrote the document — `documents.authored_by_producer`. */
  producer: string | null
}

export async function dispatchIngest(
  documentId: string,
  collectionName: string,
  storageKey: string,
  organizationId: string,
  /**
   * The bucket the object was written to (ADR-0043). Passed rather than
   * derived: the caller has just written the object and knows exactly where it
   * went, and the two presigned URLs below must both name that same bucket —
   * the download the backend reads from, and the thumbnail slot it writes back
   * to. Defaults to the shared bucket so a caller predating per-org buckets
   * keeps its old behaviour.
   */
  storageBucket: string | null = null,
  /**
   * The materialised project-folder path this document is filed under
   * (`Brandschutz/Fluchtwege`), or `null` for the project root / a shelf with no
   * folders. Sent as `folder_path` so the backend can stamp it on the
   * document's metadata row — see ADR-0049. It is the PATH, not the folder id:
   * the backend has no `project_folders` table to join against, the path is what
   * a person reads, and a prefix match over it is the folder's whole subtree.
   */
  folderPath: string | null = null,
  /** See {@link DispatchIngestExtras}. */
  extras: DispatchIngestExtras = {}
): Promise<{ jobId: string | null; status: 'pending' | 'failed' }> {
  const bucket = resolveDocumentBucket(storageBucket)
  // The backend fetches the file itself, from inside the Docker network —
  // sign with the internal-endpoint client, not the browser-facing one.
  // The ingest JOB downloads it, not the request, and the job may start long
  // after dispatch behind the bounded ingest queue: see the constant.
  const presignedUrl = await presignForBackend(
    new GetObjectCommand({ Bucket: bucket, Key: storageKey }),
    INGEST_JOB_REF_TTL_SECONDS
  )

  // Presigned upload slot for the 200px JPEG thumbnail the ingest pipeline
  // generates. Null for a key with no directory segment: there is nowhere to
  // put a sibling, and signing a bucket-root `_thumb.jpg` would hand out a
  // write capability to a shared path rather than to this document's own.
  const thumbnailUploadKey = buildThumbnailStorageKey(storageKey)
  const thumbnailUploadUrl = thumbnailUploadKey
    ? await presignForBackend(
        new PutObjectCommand({
          Bucket: bucket,
          Key: thumbnailUploadKey,
          ContentType: 'image/jpeg',
        }),
        // Written by the same job at its end, so it must outlive the queue too.
        INGEST_JOB_REF_TTL_SECONDS
      )
    : null

  // Who the ingestion's model spend is booked to on the usage ledger, beside
  // the organization: the document's project and the member who put it there.
  // Read from the row rather than threaded through every caller; a failed read
  // books the spend to the organization alone, never fails the dispatch.
  const attribution = await findDocumentInOrg(documentId, organizationId, internalRead('ingest')).catch(() => null)
  const projectFacts = await projectFactsForIngest(attribution?.projectId, organizationId)
  // The content gate's rules (ADR-0086). Every path into the index passes this
  // line — upload, re-ingest, re-index, Archiv, chat, the IFC digest — so the
  // gate is not something a new caller has to remember. A policy that cannot
  // be read sends nothing: the row fails with a retry offered.
  let screening: Awaited<ReturnType<typeof ingestScreeningFor>>
  try {
    screening = await ingestScreeningFor(organizationId, attribution)
  } catch {
    await markDocumentIngestFailed(documentId, organizationId, INGEST_DISPATCH_FAILED_MESSAGE)
    return { jobId: null, status: 'failed' }
  }

  const body = JSON.stringify({
    file_ref: presignedUrl,
    collection: collectionName,
    document_id: documentId,
    project_id: attribution?.projectId ?? null,
    user_id: attribution?.createdBy ?? null,
    // The project's facts and status, stamped onto every chunk the job writes
    // to Qdrant, so a new document is filtered and lifted like its siblings
    // from its first search (`cross-project/project-facts-mirror.ts`).
    project_facts: projectFacts,
    thumbnail_upload_url: thumbnailUploadUrl,
    // A PDF of an office original (ADR-0070), for the thumbnail: the
    // backend cannot rasterise a .docx. Null for everything else and
    // whenever conversion is off or failed. A presigned URL is a bearer
    // credential, so the backend neither stores nor logs it.
    preview_ref: extras.previewRef ?? null,
    // The same PDF, for the TEXT (ADR-0071): present only for the formats
    // `extractsFromRendition` names, and the backend then indexes it
    // instead of `file_ref`. Chunks keep the row's `file_name` either way —
    // only the bytes read differ, never the identity.
    extraction_ref: extras.extractionRef ?? null,
    folder_path: folderPath,
    // Null when screening is off for the organization or a reviewer released
    // these exact bytes from quarantine; the job then reads as it always did.
    screening,
    // The document's IDENTITY inside the collection, stated rather than
    // left to be derived. Without it the backend reads the name off the
    // presigned URL's last path segment, which is the OBJECT KEY's
    // basename — and `storageKeySegment` has already flattened that
    // (`piloti/<id>/x.md` becomes `piloti_<id>_x.md`, a name with a
    // backslash or over 255 characters becomes a different one again). The
    // chunks would then be filed under a string no purge ever asks for,
    // because every purge addresses `documents.filename`. `null` keeps the
    // old derivation for the one caller that genuinely ingests a different
    // file than the row names — the IFC digest.
    file_name: extras.fileName ?? null,
    // Only a bulk dispatch says so: the backend's default is interactive.
    ...(extras.priority === 'bulk' ? { priority: 'bulk' } : {}),
    // Only an upload a person filed as a new Fassung says so (ADR-0099).
    ...(extras.revisionOf ? { revision_of: extras.revisionOf } : {}),
    // Absent for every human document, and the Python side treats absent,
    // null and a non-agent author identically (`parse_agent_provenance`).
    // Spread so the four keys are the four keys, never a nested object the
    // chunk metadata would have to be taught to flatten.
    ...(extras.provenance ?? {}),
  })

  // A timeout is not a failure the backend reported: the request may still be
  // downloading, and would then start the job after this caller had recorded
  // `failed` — a false failure, and a duplicate once someone retries. The
  // backend is idempotent per document and object (`/v1/ingest`), so the same
  // request once more either joins the job the first one started or, when the
  // first never arrived, starts it. Only a second timeout records a failure.
  let attempt = await requestIngestJob(body, organizationId)
  if (attempt.timedOut) attempt = await requestIngestJob(body, organizationId)
  const ingestJobId = attempt.jobId

  if (ingestJobId) {
    await setDocumentIngestJob(documentId, organizationId, ingestJobId)
    return { jobId: ingestJobId, status: 'pending' }
  }
  // No job id, failed or not. The backend answers 202 with a `job_id` on every
  // success (`backend/routes/ingest.py`), so an OK response without one is not
  // a quieter success — it is a response this caller does not understand, and
  // leaving the row at its birth status ('uploaded', which the badge renders
  // green "Ready") would promise citations for a document nothing ever
  // indexed. Failed with retry offered is the honest state either way.
  await markDocumentIngestFailed(documentId, organizationId, INGEST_DISPATCH_FAILED_MESSAGE)
  return { jobId: null, status: 'failed' }
}
