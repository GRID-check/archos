/**
 * The background jobs that process a document off the request: the BIM extraction and the office
 * rendition ingest.
 */

import 'server-only'
import { GetObjectCommand } from '@aws-sdk/client-s3'
import { presignForBackend } from '@/lib/s3'
import { resolveDocumentBucket } from '@/lib/storage/bucket'
import { findDocumentInOrg, markDocumentIngestFailed } from './repository'
import { runBimExtraction } from '@/lib/bim/service'
import type { BimExtractPayload, JobAttempt, OfficeRenditionPayload } from '@/lib/jobs-queue/types'
import { internalRead } from './document-reader'
import { ensureRendition, extractsFromRendition } from './rendition'
import { type DispatchDocumentInput, mayBeIndexed } from './document-dispatch'
import { INGEST_DISPATCH_FAILED_MESSAGE, INGEST_JOB_REF_TTL_SECONDS, RENDITION_REQUIRED_MESSAGE, dispatchIngest } from './ingest-dispatch'

/**
 * The job half of {@link beginModelExtraction}: parse the model, store its
 * index and digest, and dispatch the digest to the ordinary ingest path.
 *
 * Runs on a `bff-jobs` pod, as the system. The row is read again because the
 * job may have waited for hours: a document deleted or replaced meanwhile, or
 * already moved on by the claim of a worker that died after finishing, is left
 * alone. `runBimExtraction` does not throw for a model it cannot read (that is a
 * documented state of the model), so a throw here is infrastructure and goes
 * back to the queue; the last attempt leaves the row failed first.
 */
export async function runBimExtractJob(
  organizationId: string,
  payload: BimExtractPayload,
  attempt: JobAttempt
): Promise<void> {
  const input = dispatchInputOf(organizationId, payload)
  if (!(await jobStillOwnsRow(input))) return

  await failRowOnLastAttempt(input, attempt, 'IFC extraction failed', async () => {
    const outcome = await runBimExtraction({
      organizationId,
      projectId: input.projectId,
      documentId: input.documentId,
      filename: input.filename,
      storageKey: input.storageKey,
      storageBucket: input.storageBucket,
      // No `fileName`: what is ingested here is the Markdown DIGEST, not the
      // model the row names, so the backend's own derivation from the presigned
      // URL (`digest.md`) is what these chunks have always been filed under.
      // Stating `input.filename` would rename them to `haus.ifc` and orphan every
      // chunk already written under the old name. That the row's purge therefore
      // addresses a name its chunks do not carry is a defect this change did not
      // introduce and does not fix.
      dispatchDigest: (digestStorageKey) =>
        dispatchIngest(
          input.documentId,
          input.collectionName,
          digestStorageKey,
          organizationId,
          input.storageBucket,
          input.folderPath ?? null,
          { priority: input.priority }
        ),
    })
    if (outcome.status === 'failed') {
      await markDocumentIngestFailed(input.documentId, organizationId, outcome.error ?? 'IFC extraction failed')
    }
  })
}

/** The dispatch a queued payload stands for. */
function dispatchInputOf(organizationId: string, payload: BimExtractPayload): DispatchDocumentInput {
  return {
    organizationId,
    projectId: payload.projectId,
    documentId: payload.documentId,
    filename: payload.filename,
    storageKey: payload.storageKey,
    storageBucket: payload.storageBucket,
    collectionName: payload.collectionName,
    folderPath: payload.folderPath ?? null,
    versionId: payload.versionId ?? null,
    priority: payload.priority,
  }
}

/**
 * Whether the row still waits for the work a job was queued for.
 *
 * False for a document that was deleted, whose bytes were replaced (the newer
 * dispatch queued its own job) or that is no longer `processing`. The last is
 * the one that matters after a crash: a worker that finished the work and died
 * before it could finish the job leaves a claim another worker takes over, and
 * doing the work a second time would dispatch the same ingest twice. A machine's
 * document is held to the publish rule again, because it may have been
 * superseded while it waited.
 */
async function jobStillOwnsRow(input: DispatchDocumentInput): Promise<boolean> {
  const row = await findDocumentInOrg(input.documentId, input.organizationId, internalRead('ingest'))
  if (!row) return false
  if (row.storageKey !== input.storageKey || row.status !== 'processing') return false
  return mayBeIndexed(row, input.versionId ?? null)
}

/**
 * Run `work`; when it throws on the last attempt the queue gives it, say so on
 * the row before the queue buries the job. The error is rethrown either way, so
 * the queue still counts the attempt.
 */
async function failRowOnLastAttempt(
  input: DispatchDocumentInput,
  attempt: JobAttempt,
  message: string,
  work: () => Promise<void>
): Promise<void> {
  try {
    await work()
  } catch (error) {
    if (attempt.last) {
      await markDocumentIngestFailed(input.documentId, input.organizationId, message).catch(() => undefined)
    }
    throw error
  }
}

/**
 * The job half of {@link beginRenditionIngest}. Same guards and same last-attempt
 * rule as {@link runBimExtractJob}.
 *
 * A conversion the converter refuses is not an error here: the document fails
 * with {@link RENDITION_REQUIRED_MESSAGE}, which is what "Erneut lesen"
 * retries, and the job is finished. A retry by the queue would run the same
 * file through the same converter again within the minute.
 */
export async function runOfficeRenditionJob(
  organizationId: string,
  payload: OfficeRenditionPayload,
  attempt: JobAttempt
): Promise<void> {
  const input = {
    ...dispatchInputOf(organizationId, payload),
    provenance: payload.provenance ?? null,
    revisionOf: payload.revisionOf ?? payload.fassungOf ?? null,
  }
  if (!(await jobStillOwnsRow(input))) return

  await failRowOnLastAttempt(input, attempt, INGEST_DISPATCH_FAILED_MESSAGE, () =>
    ingestThroughRendition(input, payload.fileName)
  )
}

/**
 * The conversion and ingest {@link runOfficeRenditionJob} runs.
 *
 * For a Word or presentation file the rendition IS the source, so a failed
 * conversion fails the document with {@link RENDITION_REQUIRED_MESSAGE}; the
 * existing retry re-runs the conversion. A spreadsheet only loses its
 * thumbnail and is ingested from the original as before.
 */
async function ingestThroughRendition(input: DispatchDocumentInput, fileName: string): Promise<void> {
  const renditionRef = await signedRenditionRef(input, fileName)
  const indexesRendition = extractsFromRendition(fileName)
  if (indexesRendition && !renditionRef) {
    await markDocumentIngestFailed(input.documentId, input.organizationId, RENDITION_REQUIRED_MESSAGE)
    return
  }
  await dispatchIngest(
    input.documentId,
    input.collectionName,
    input.storageKey,
    input.organizationId,
    input.storageBucket,
    input.folderPath ?? null,
    {
      fileName,
      provenance: input.provenance ?? null,
      previewRef: renditionRef,
      // A spreadsheet's rendition is a thumbnail only: its text keeps the
      // structure-preserving extractor (see `extractsFromRendition`).
      extractionRef: indexesRendition ? renditionRef : null,
      priority: input.priority,
      revisionOf: input.revisionOf ?? null,
    }
  )
}

/**
 * A signed read of the rendition, or `null` when there is none to give.
 *
 * Signed with the INTERNAL client like `file_ref`: the backend reads it from
 * inside the Docker network, as part of the job, so it is minted right before
 * the POST rather than when the conversion started.
 *
 * Valid for {@link INGEST_JOB_REF_TTL_SECONDS}, like `file_ref` and the
 * thumbnail slot, not for the default presign TTL: the job downloads it when an
 * ingest worker reaches it, and behind a queue of plan sets that can be hours.
 * An expired link fails the document as `office_rendition_required`, which
 * would read as a converter fault.
 */
async function signedRenditionRef(input: DispatchDocumentInput, fileName: string): Promise<string | null> {
  const bucket = resolveDocumentBucket(input.storageBucket)
  try {
    const renditionKey = await ensureRendition({ bucket, storageKey: input.storageKey, filename: fileName })
    return await presignForBackend(new GetObjectCommand({ Bucket: bucket, Key: renditionKey }), INGEST_JOB_REF_TTL_SECONDS)
  } catch (error) {
    console.warn(
      '[documents] office rendition at ingest failed:',
      error instanceof Error ? error.message : String(error)
    )
    return null
  }
}
