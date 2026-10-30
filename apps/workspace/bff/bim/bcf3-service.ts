/**
 * A model's Anmerkungen as a BCF 3.0 file: the reads, then
 * {@link buildAnnotationsBcf3} (`./bcf3-build.ts`).
 *
 * ## The read gate
 *
 * The same one the Protokoll export has (`annotations/export.ts`):
 * `getAccessibleDocument(…, 'read')`, then {@link listAnnotations}, so a held
 * upload, a document in a folder the reader may not open and another
 * organization's model are all 404, and the marks are the ones that listing
 * shows this person. The model comes through `getModelForDocument`, which
 * checks the IFC switch and `documentVisibleTo`. Snapshots are read through
 * `readSnapshot`, the one reader of that object store prefix, keyed by the row
 * of a viewpoint the document owns.
 *
 * ## What is exported
 *
 * Marks anchored to a viewpoint, by number. The agent's proposals nobody took over
 * are not the office's record and never go; `scope=open` leaves the closed ones
 * out. A snapshot whose object is gone is left out of its topic (the topic
 * keeps its camera). The pictures together are bounded
 * ({@link MAX_BCF3_SNAPSHOT_BYTES}, less for an agent), in mark order by their
 * stored size, before any is read; past it the remaining topics go without a
 * picture and the count of those is returned, so a caller can say so.
 *
 * An audit event records the export (`document.annotations.exported`, format
 * `bcf3`): office review content leaving the product.
 */

import 'server-only'
import { getLocale, getTranslations } from '@/i18n/server'
import { filesCopy } from '@/i18n/namespaces/files'
import type { Translator } from '@/i18n/translate'
import { PRODUCT_NAME } from '@/lib/brand'
import { OFFICE_TIME_ZONE } from '@/lib/format'
import { actingReaderIsAgent } from '@/lib/agent-api/acting-session'
import { NotFoundError, UnprocessableError } from '@/lib/api/errors'
import { recordAuditEvent } from '@/lib/audit/service'
import type { AuthorizedSession } from '@/lib/auth/types'
import { getAccessibleDocument } from '@/lib/documents/access'
import { documentDisplayName, splitDocumentName } from '@/lib/documents/display-name'
import { safeFileStem } from '@/lib/annotations/export-request'
import { listAnnotations } from '@/lib/annotations/service'
import { AGENT_AUTHOR, isLive, isUnreviewedProposal, type AnnotationView } from '@/lib/annotations/types'
import { findViewpoints } from '@/lib/annotations/viewpoint-repository'
import { toViewpointView } from '@/lib/annotations/viewpoint-read'
import { readSnapshot } from '@/lib/annotations/viewpoint-snapshot'
import type { AnnotationViewpointRow } from '@/lib/db/schema/annotation-viewpoints'
import type { Document } from '@/lib/db/schema/documents'
import { loadOrganizationDirectory } from '@/lib/sharing/directory'
import { buildAnnotationsBcf3, type Bcf3Export, type Bcf3Snapshot, type Bcf3Topic } from './bcf3-build'
import type { Bcf3Query } from './bcf3-wire'
import { getModelForDocument } from './model-service'

/** Pictures in one archive, together. 40 MiB: a few hundred phone-sized screenshots, and room left for the response. */
export const MAX_BCF3_SNAPSHOT_BYTES = 40 * 1024 * 1024
/**
 * The same bound for an agent's call: the MCP door sends a binary answer inline
 * only up to 5 MiB (`MAX_INLINE_BYTES`) and describes a larger one, so pictures
 * past this would be read, zipped and thrown away.
 */
export const MAX_BCF3_AGENT_SNAPSHOT_BYTES = 4 * 1024 * 1024
/** Snapshots read from the object store at once. */
const SNAPSHOT_READS = 6

export interface ExportedAnnotationsBcf3 extends Bcf3Export {
  filename: string
  /** Topics that went without their picture: the object was gone, or the size bound was reached. */
  snapshotsOmitted: number
}

type ExportableMark = AnnotationView & { status: Bcf3Topic['status']; viewpoint: NonNullable<AnnotationView['viewpoint']> }

const exportable = (mark: AnnotationView, scope: Bcf3Query['scope']): mark is ExportableMark =>
  mark.viewpoint != null &&
  mark.status !== 'proposed' &&
  !isUnreviewedProposal(mark) &&
  (scope === 'all' || isLive(mark))

/**
 * Which pictures go, in mark order: by the size each row stored, until the
 * next one would pass `cap`; that one and every later one stay out. Decided
 * before anything is read, so the same marks give the same file and nothing is
 * fetched past the bound.
 */
export function snapshotsWithin(rows: readonly AnnotationViewpointRow[], cap: number): AnnotationViewpointRow[] {
  const chosen: AnnotationViewpointRow[] = []
  let total = 0
  for (const row of rows) {
    if (!row.snapshotKey || !row.snapshotContentType) continue
    total += row.snapshotBytes ?? 0
    if (total > cap) break
    chosen.push(row)
  }
  return chosen
}

/** The pictures of these viewpoints, by viewpoint id, in bounded parallel; a picture that no longer exists is absent. */
async function readSnapshots(
  doc: Pick<Document, 'storageBucket'>,
  rows: readonly AnnotationViewpointRow[]
): Promise<Map<string, Bcf3Snapshot>> {
  const found = new Map<string, Bcf3Snapshot>()
  for (let at = 0; at < rows.length; at += SNAPSHOT_READS) {
    const batch = await Promise.all(
      rows.slice(at, at + SNAPSHOT_READS).map(async (row) => {
        // Rows with a snapshot always have both (`annotation_viewpoints_snapshot_complete`).
        const bytes = await readSnapshot(doc, row.snapshotKey ?? '').catch((error: unknown) => {
          if (error instanceof NotFoundError) return null
          throw error
        })
        return { row, bytes }
      })
    )
    for (const { row, bytes } of batch) {
      if (bytes) found.set(row.id, { contentType: row.snapshotContentType as Bcf3Snapshot['contentType'], bytes })
    }
  }
  return found
}

interface Person {
  email: string | null
}

/** How a person is named in a BCF file: their email when the directory has one, else the name, else the id. */
const bcfName = (people: ReadonlyMap<string, Person>, userId: string, name: string | null): string =>
  people.get(userId)?.email ?? name ?? userId

interface Wording {
  t: Translator
  /** The day of an instant on the office's calendar, as the Protokoll writes it. */
  date: (iso: string) => string
}

/** The Description's lines after the body: the basis, and who set the mark when the agent did; the Protokoll's words. */
function notesOf(mark: ExportableMark, { t, date }: Wording): string[] {
  const notes = mark.basis ? [`${t('review.export.document.basis')}: ${mark.basis}`] : []
  if (mark.authorKind === AGENT_AUTHOR) {
    const set = date(mark.createdAt)
    notes.push(
      mark.acceptedByName
        ? t('review.export.document.agentSetFor', { name: mark.acceptedByName, date: set })
        : t('review.export.document.agentSet', { date: set })
    )
  }
  return notes
}

function toTopic(
  mark: ExportableMark,
  people: ReadonlyMap<string, Person>,
  viewpoints: ReadonlyMap<string, AnnotationViewpointRow>,
  snapshots: ReadonlyMap<string, Bcf3Snapshot>,
  wording: Wording,
  exported: ReadonlySet<string>
): Bcf3Topic {
  const related = mark.carriedFrom?.annotationId.toLowerCase() ?? null
  const row = viewpoints.get(mark.viewpoint.id)
  const content = row ? toViewpointView(row) : null
  return {
    id: mark.id.toLowerCase(),
    number: mark.number,
    kind: mark.kind,
    status: mark.status,
    body: mark.body,
    notes: notesOf(mark, wording),
    assignedTo: mark.assigneeUserId ? (people.get(mark.assigneeUserId)?.email ?? mark.assigneeName) : null,
    dueOn: mark.dueOn,
    createdBy: bcfName(people, mark.createdBy, mark.createdByName),
    createdAt: new Date(mark.createdAt),
    modified:
      mark.closedBy && mark.closedAt
        ? { by: bcfName(people, mark.closedBy, mark.closedByName), at: new Date(mark.closedAt) }
        : null,
    replies: mark.replies.map((reply) => ({
      id: reply.id.toLowerCase(),
      author: reply.authorKind === AGENT_AUTHOR ? PRODUCT_NAME : bcfName(people, reply.createdBy, reply.createdByName),
      date: new Date(reply.createdAt),
      body: reply.body,
      editedAt: reply.editedAt ? new Date(reply.editedAt) : null,
    })),
    viewpoint: content
      ? {
          id: content.id.toLowerCase(),
          camera: content.camera,
          clippingPlanes: content.clippingPlanes,
          components: content.components,
          snapshot: snapshots.get(content.id) ?? null,
        }
      : null,
    // Only a topic in this file: a reference to one the reader cannot open from it dangles.
    relatedTopicId: related && exported.has(related) ? related : null,
  }
}

/** „Anmerkungen – Haus A.bcf": the Protokoll's name for the same document, with BCF's extension. */
const bcfFileName = (doc: Document, t: Translator): string =>
  `${safeFileStem(t('review.export.document.fileName', { name: splitDocumentName(documentDisplayName(doc)).stem }))}.bcf`

/**
 * The model document's Anmerkungen as a BCF 3.0 archive, for a person who may
 * read it; 404 for anyone else, 422 for a document that is no IFC model.
 */
export async function exportAnnotationsBcf3(
  session: AuthorizedSession,
  documentId: string,
  query: Bcf3Query,
  request?: Request
): Promise<ExportedAnnotationsBcf3> {
  const doc = await getAccessibleDocument(session, documentId, 'read')
  const model = await getModelForDocument(session, doc.id)
  if (!model) throw new UnprocessableError('Only an IFC model has a BCF file.', { reason: 'not_a_model' })

  const [{ annotations }, people, locale] = await Promise.all([
    listAnnotations(session, doc.id),
    loadOrganizationDirectory(session.organizationId),
    getLocale(),
  ])
  // Bound by name, so `key-coverage.spec.ts` checks every key this file asks for against `files`.
  const t = await getTranslations(filesCopy)
  const day = new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeZone: OFFICE_TIME_ZONE })
  const wording: Wording = { t, date: (iso) => day.format(new Date(iso)) }
  const marks = annotations.filter((mark): mark is ExportableMark => exportable(mark, query.scope)).sort((a, b) => a.number - b.number)
  const rows = await findViewpoints(session.organizationId, doc.id, marks.map((mark) => mark.viewpoint.id))
  const viewpoints = new Map(rows.map((row) => [row.id, row]))
  const inMarkOrder = marks.flatMap((mark) => viewpoints.get(mark.viewpoint.id) ?? [])
  const cap = actingReaderIsAgent() ? MAX_BCF3_AGENT_SNAPSHOT_BYTES : MAX_BCF3_SNAPSHOT_BYTES
  const snapshots = await readSnapshots(doc, snapshotsWithin(inMarkOrder, cap))
  const exported = new Set(marks.map((mark) => mark.id.toLowerCase()))

  const topics = marks.map((mark) => toTopic(mark, people, viewpoints, snapshots, wording, exported))
  const root = model.summary?.spatial
  const file = buildAnnotationsBcf3({
    model: {
      filename: model.filename,
      ifcProjectGlobalId: root?.ifcType === 'IfcProject' ? root.globalId : null,
      updatedAt: model.updatedAt,
    },
    topics,
  })

  await recordAuditEvent({
    organizationId: session.organizationId,
    actor: { userId: session.userId, email: session.email },
    action: 'document.annotations.exported',
    targetType: 'document',
    targetId: doc.id,
    metadata: {
      format: 'bcf3',
      scope: query.scope,
      revision: 'all',
      includeProposals: false,
      markCount: topics.length,
      proposalCount: 0,
    },
    request,
  })

  const withPicture = inMarkOrder.filter((row) => row.snapshotKey).length
  return { ...file, filename: bcfFileName(doc, t), snapshotsOmitted: withPicture - snapshots.size }
}
