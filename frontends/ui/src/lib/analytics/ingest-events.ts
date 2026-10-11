/**
 * `document_ingest_finished` for PostHog (ADR-0100): an upload came to rest.
 *
 * The server is the only place that knows. The browser sees `document_uploaded`
 * when the bytes leave; whether the file then became searchable, failed or was
 * quarantined happens minutes later in the ingest job, and is learnt by whichever
 * read first reconciles the row (`reconcile-status.ts`). That read already knows
 * which rows IT moved (`moved`), so a row is announced once, by the read whose
 * write landed, exactly as it is settled once.
 *
 * Personless on purpose: the read that notices is often somebody else's page
 * load, so the actor is not the uploader, and attributing the outcome to the
 * reader would be wrong. The organization is the dimension that matters.
 *
 * Lives here and not beside `reconcile-status.ts` because `document-status.spec.ts`
 * scans `lib/documents` for every `status:` it writes, and this event's `status`
 * property is a report about the column, not a write to it.
 *
 * What is sent: the outcome, the screening verdict, the counts the backend
 * reported, the file's extension and how long it took. Never the filename,
 * the summary or the error text, which can quote the document.
 */
import { captureServer } from './posthog-server'

export interface FinishedIngest {
  filename: string
  /** When the row was last written: the dispatch time for a row that was in flight. */
  updatedAt?: Date | string | null
  status: 'completed' | 'failed' | 'quarantined'
  /** What the content gate concluded (ADR-0086), when it ran. */
  screening?: string
  pageCount?: number
  chunkCount?: number
}

const EXTENSION = /^[a-z0-9]{1,8}$/

/** The lower-cased extension, or `other` for anything that is not a plain one. Never the name. */
export const fileTypeOf = (filename: string): string => {
  const dot = filename.lastIndexOf('.')
  if (dot === -1) return 'none'
  const extension = filename.slice(dot + 1).toLowerCase()
  return EXTENSION.test(extension) ? extension : 'other'
}

/**
 * Milliseconds from the row's last write to `now`. For a row that was in flight
 * that write is the dispatch (`setDocumentIngestJob`), so this is the ingest
 * duration to within one poll interval; `undefined` when the row has no usable
 * time rather than a wrong number.
 */
const durationSince = (updatedAt: Date | string | null | undefined, now: number): number | undefined => {
  if (!updatedAt) return undefined
  const written = new Date(updatedAt).getTime()
  return Number.isFinite(written) ? Math.max(0, now - written) : undefined
}

/** Queue one event per finished row. Fire-and-forget: `captureServer` never throws. */
export function announceIngestsFinished(organizationId: string, finished: FinishedIngest[], now = Date.now()): void {
  for (const ingest of finished) {
    captureServer({
      event: 'document_ingest_finished',
      distinctId: null,
      organizationId,
      properties: {
        status: ingest.status,
        screening: ingest.screening,
        file_type: fileTypeOf(ingest.filename),
        page_count: ingest.pageCount,
        chunk_count: ingest.chunkCount,
        duration_ms: durationSince(ingest.updatedAt, now),
      },
    })
  }
}
