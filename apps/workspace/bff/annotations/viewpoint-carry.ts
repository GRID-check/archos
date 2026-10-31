/**
 * A mark on a model goes on with the model's next Fassung („übernehmen“,
 * migration 0195): the part of `carryToCurrent` (`./service.ts`) that knows
 * viewpoints, and the count the review shows before anyone clicks.
 *
 * **Which Fassung.** The same two a page mark goes on to, and nothing else: the
 * model's own published version when the same file was uploaded again (in
 * place: the mark keeps its number and thread), or, when a person confirmed
 * that another document replaces it, that document's (across: a linked mark
 * there, the old one closed, as `carryAcross` does). The revision series read
 * from file names (`lib/bim/revision-series.ts`) is a guess for the timeline,
 * not a person's word, so a mark never follows it.
 *
 * **What goes along.** The elements, by IFC GlobalId, against the elements the
 * new Fassung's model holds (`bim_elements`); presence is enough. An element
 * whose properties changed (`lib/bim/compare.ts`'s „changed“) is still the
 * element the mark asks about, and is often exactly what it asked for. The new
 * viewpoint is written by `./viewpoint-carry-plan.ts`; the old one stays,
 * immutable, with its Fassung and its snapshot.
 *
 * **None left.** The mark keeps its last viewpoint and says so
 * (`anchor_lost_at`, „Bauteile nicht mehr im Modell“): in place it still
 * moves to the current Fassung, across it stays on the replaced model, open,
 * since there is nothing on the new one to set it on.
 *
 * Piloti's proposals go on in place, as proposals; across only an open mark
 * goes, as a page mark does (a proposal is not the office's record to close).
 */

import 'server-only'
import { randomUUID } from 'node:crypto'
import { NotFoundError, UnprocessableError } from '@/lib/api/errors'
import { captureServer } from '@/lib/analytics/posthog-server'
import type { AuthorizedSession } from '@/lib/auth/types'
import { findBimModelByDocument } from '@/lib/bim/repository'
import type { AnnotationViewpointRow } from '@/lib/db/schema/annotation-viewpoints'
import type { DocumentAnnotationRow } from '@/lib/db/schema/document-annotations'
import type { Document } from '@/lib/db/schema/documents'
import { memberReader } from '@/lib/documents/visibility'
import type { CarryWay } from './carry'
import type { NewAnnotationValues } from './repository'
import { isLive, type CarryTargetView } from './types'
import {
  carriedViewpointValues,
  losesAnchor,
  markElementIds,
  presenceOf,
  viewpointElementIds,
  type ElementPresence,
} from './viewpoint-carry-plan'
import {
  carryViewpointMarkAcross,
  carryViewpointMarkInPlace,
  markViewpointAnchorLost,
  presentGlobalIds,
  versionNumberOf,
} from './viewpoint-carry-repository'
import { findViewpoint, findViewpoints, viewpointSummariesOfMarks } from './viewpoint-repository'
import type { ViewpointSummary } from './viewpoint-types'

/** What a carry would find, per mark: its elements in the Fassung it lands on, and that Fassung's number. */
export interface CarryPresence extends ElementPresence {
  revisionNumber: number | null
}

/** The marks' viewpoint summaries by viewpoint id, and, where this reader may carry them, what a carry would find (by mark id). */
export type MarkViewpoints = ReadonlyMap<string, ViewpointSummary> & { carry?: ReadonlyMap<string, CarryPresence> }

type MarkFields = Pick<
  DocumentAnnotationRow,
  'id' | 'documentId' | 'anchorKind' | 'viewpointId' | 'status' | 'versionId' | 'delegatedBy' | 'anchorLostAt'
>

/** Whether this reader's carry would take this mark: live and behind in place, open and not Piloti's to work across. */
function carries(record: MarkFields, doc: Pick<Document, 'publishedVersionId'>, way: CarryWay): boolean {
  if (record.anchorKind !== 'viewpoint' || !record.viewpointId) return false
  if (way.across) return record.status === 'open' && !record.delegatedBy
  return isLive(record) && (record.versionId ?? null) !== (doc.publishedVersionId ?? null)
}

/** The model of a document as this reader sees it, when it is ready to be compared against; null otherwise. */
async function readyModel(session: AuthorizedSession, documentId: string) {
  const model = await findBimModelByDocument(documentId, session.organizationId, memberReader(session.userId))
  return model?.status === 'ready' ? model : null
}

/** The GlobalIds of `ids` the model has; all of them when its element list is truncated, since a missing one may be in the part not stored. */
async function presentIn(
  session: AuthorizedSession,
  model: NonNullable<Awaited<ReturnType<typeof readyModel>>>,
  ids: readonly string[]
): Promise<Set<string>> {
  if (model.summary?.truncatedAt != null) return new Set(ids)
  return presentGlobalIds(session.organizationId, model.id, ids, memberReader(session.userId))
}

/**
 * The summaries of the viewpoints these marks name, and, for the ones this
 * reader's carry would take (`way`, read beside it), how many of their
 * elements the Fassung they land on has. A model not ready, or a read that
 * fails, offers no carry: the list does not fail on it.
 */
export async function markViewpointsOf(
  session: AuthorizedSession,
  doc: Document,
  records: readonly MarkFields[],
  way: CarryWay | null | Promise<CarryWay | null>
): Promise<MarkViewpoints> {
  const [summaries, carryWay] = await Promise.all([viewpointSummariesOfMarks(session.organizationId, doc.id, records), way])
  const carry = carryWay
    ? await carryPresenceOf(session, doc, records, carryWay).catch((error: unknown) => {
        console.warn(`[annotations] could not count what a carry of document ${doc.id}'s model marks finds:`, error)
        return new Map<string, CarryPresence>()
      })
    : new Map<string, CarryPresence>()
  return Object.assign(summaries, { carry })
}

async function carryPresenceOf(
  session: AuthorizedSession,
  doc: Document,
  records: readonly MarkFields[],
  way: CarryWay
): Promise<Map<string, CarryPresence>> {
  const marks = records.filter((record) => carries(record, doc, way))
  if (marks.length === 0) return new Map()
  const model = await readyModel(session, way.to.documentId)
  if (!model) return new Map()
  const viewpoints = await findViewpoints(
    session.organizationId,
    doc.id,
    marks.flatMap((mark) => (mark.viewpointId ? [mark.viewpointId] : []))
  )
  const byId = new Map(viewpoints.map((viewpoint) => [viewpoint.id, viewpoint]))
  const [present, revisionNumber] = await Promise.all([
    presentIn(session, model, [...new Set(viewpoints.flatMap(markElementIds))]),
    versionNumberOf(session.organizationId, way.to.documentId, way.versionId),
  ])
  const result = new Map<string, CarryPresence>()
  for (const mark of marks) {
    const viewpoint = mark.viewpointId ? byId.get(mark.viewpointId) : undefined
    if (viewpoint) result.set(mark.id, { ...presenceOf(viewpoint, present), revisionNumber })
  }
  return result
}

/**
 * Where „übernehmen“ takes a mark on a model for this reader, with the count
 * the review shows („3 von 3 Bauteilen in Fassung 4“), or null where the
 * carry would refuse or change nothing: a mark across whose elements are
 * already known to be gone stays as it is.
 */
export function viewpointCarryTarget(
  record: MarkFields,
  way: CarryWay | null,
  viewpoints: MarkViewpoints
): CarryTargetView | null {
  const presence = viewpoints.carry?.get(record.id)
  if (!way || !presence) return null
  if (way.across && record.anchorLostAt && presence.present === 0) return null
  return { ...way.to, revisionNumber: presence.revisionNumber, elements: { present: presence.present, total: presence.total } }
}

const refuse = (message: string, reason: string) => new UnprocessableError(message, { field: 'carryToCurrent', reason })

/** The ready model of the document a mark lands on, or the refusal a caller can act on. */
async function requireReadyModel(session: AuthorizedSession, documentId: string) {
  const model = await readyModel(session, documentId)
  if (!model) throw refuse('The model of the current Fassung is not ready yet. Carry the mark when it is.', 'model_not_ready')
  return model
}

/** The viewpoint a mark names, as stored. */
async function sourceViewpoint(organizationId: string, mark: MarkFields): Promise<AnnotationViewpointRow> {
  const viewpoint = mark.viewpointId ? await findViewpoint(organizationId, mark.documentId, mark.viewpointId) : null
  if (!viewpoint) throw new NotFoundError()
  return viewpoint
}

/** What one carry found and did, for the product's numbers: never the elements, only their count. */
function carryEvent(
  session: AuthorizedSession,
  documentId: string,
  way: 'in_place' | 'across',
  presence: ElementPresence,
  by: 'person' | 'piloti'
): void {
  captureServer({
    event: 'annotation_viewpoint_carried',
    distinctId: session.userId,
    organizationId: session.organizationId,
    properties: {
      document_id: documentId,
      way,
      outcome: losesAnchor(presence) ? 'anchor_lost' : 'carried',
      present: presence.present,
      total: presence.total,
      by,
    },
  })
}

/**
 * A mark on a model goes on with its own document's current Fassung: onto a
 * new viewpoint with the elements still there, or, none left, keeping its
 * viewpoint and saying so. False when it moved since it was read (the
 * caller's conflict); true when it is on the current Fassung already.
 */
export async function carryViewpointInPlace(
  session: AuthorizedSession,
  doc: Document,
  existing: MarkFields,
  by: 'person' | 'piloti'
): Promise<boolean> {
  const current = doc.publishedVersionId ?? null
  if ((existing.versionId ?? null) === current) return true
  const model = await requireReadyModel(session, doc.id)
  const source = await sourceViewpoint(session.organizationId, existing)
  const present = await presentIn(session, model, viewpointElementIds(source))
  const presence = presenceOf(source, present)
  const row = await carryViewpointMarkInPlace({
    organizationId: session.organizationId,
    documentId: doc.id,
    mark: { id: existing.id, status: existing.status, versionId: existing.versionId ?? null, viewpointId: source.id },
    toVersionId: current,
    viewpoint: losesAnchor(presence) ? null : carriedViewpointValues(source, present, randomUUID()),
    carriedBy: session.userId,
  })
  if (!row) return false
  carryEvent(session, doc.id, 'in_place', presence, by)
  return true
}

/** What `carryAcross` (`./service.ts`) hands over: the mark, where it goes, and what it keeps there. */
export interface AcrossCarry {
  organizationId: string
  source: DocumentAnnotationRow
  target: { documentId: string; versionId: string | null }
  values: Pick<NewAnnotationValues, 'mentions' | 'assigneeUserId'>
  closedBy: string
}

/**
 * The open mark of a replaced model goes on as a mark of the replacing one,
 * onto a new viewpoint there with the elements that model has. None left: the
 * mark stays on the replaced model, open, and says so; the row returned is
 * then the source's own (the caller tells the two apart by its document).
 * Null when it moved since it was read.
 */
export async function carryViewpointAcross(
  session: AuthorizedSession,
  carry: AcrossCarry,
  by: 'person' | 'piloti'
): Promise<DocumentAnnotationRow | null> {
  const { source } = carry
  if (source.status !== 'open') {
    throw refuse('Take the proposal over before it goes on with the replacing model.', 'proposed')
  }
  const model = await requireReadyModel(session, carry.target.documentId)
  const viewpoint = await sourceViewpoint(session.organizationId, source)
  const present = await presentIn(session, model, viewpointElementIds(viewpoint))
  const presence = presenceOf(viewpoint, present)
  const mark = { id: source.id, status: source.status, versionId: source.versionId ?? null, viewpointId: viewpoint.id }
  const row = losesAnchor(presence)
    ? await markViewpointAnchorLost({ organizationId: carry.organizationId, documentId: source.documentId, mark })
    : await carryViewpointMarkAcross({ ...carry, viewpoint: carriedViewpointValues(viewpoint, present, randomUUID()) })
  if (row) carryEvent(session, source.documentId, 'across', presence, by)
  return row
}
