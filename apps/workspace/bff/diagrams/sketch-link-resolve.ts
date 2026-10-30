/**
 * A Skizze's links as one reader sees them (S5, `sketch-links.ts`).
 *
 * The scene stores ids; this asks, with the reader's own rights, what each id is
 * for them. Every target goes through the door its own surface uses: a document
 * through `getAccessibleDocument` (the shelf's rule, a folder the reader may not
 * see, a held upload), a model element through the model service
 * (`findElementsOfReadDocument`, after the document's own door), an Anmerkung
 * through its document and then its row. A pinned Fassung is shown only when it
 * was published and its bytes are the reader's to receive
 * (`versionBytesReadableBy`): a draft in Freigabe or a held upload stays
 * unavailable, number included. A target that is gone, or that this
 * reader may not open, is `unavailable` and nothing more: no title, no reason,
 * so the sketch says nothing of a document its reader cannot see.
 *
 * The cost is bounded by documents, not links: the links are grouped by the
 * document they name, each document's access is asked once, and its pinned
 * Fassungen, its Anmerkungen and its model's elements are read in one query
 * each, no reply thread among them; at most {@link SKETCH_LINK_DOCUMENTS_AT_ONCE}
 * documents are asked at a time, so one sketch never takes the whole pool.
 *
 * A link never fails the read. Whatever goes wrong resolving one (a refusal, a
 * row that is gone, a database error) makes it, and only the links that depend
 * on the same lookup, `unavailable`; an unexpected error is logged.
 *
 * The answer is a reading: nothing here is stored, and nothing a reader learns
 * from one link reaches the scene, the search row (`sketch-search.ts`, which
 * indexes no link) or another reader.
 */

import 'server-only'
import { ApiError } from '@/lib/api/errors'
import type { AuthorizedSession } from '@/lib/auth/types'
import { findElementsOfReadDocument } from '@/lib/bim/model-service'
import type { Document } from '@/lib/db/schema/documents'
import { getAccessibleDocument } from '@/lib/documents/access'
import { versionBytesReadableBy } from '@/lib/documents/version-content'
import { inPool } from '@/lib/utils/in-pool'
import type { ResolvedSketchLink, SketchLinkPlace, SketchOutlineLink } from './sketch-links'
import { listAnnotationHeads, listPinnedVersions } from './sketch-link-repository'

/** At most this many links are resolved on one read; the rest read as unavailable. A sketch is a page, not a register. */
export const MAX_RESOLVED_SKETCH_LINKS = 60
/** Documents asked at once: a sketch read shares the pool (`DEFAULT_DB_POOL_MAX`) with every other request. */
export const SKETCH_LINK_DOCUMENTS_AT_ONCE = 4

const ANNOTATION_TITLE_CHARS = 80
/** The Fassungen a link may pin and show: one that was the document's published one. */
const SHOWN_VERSION_STATES: ReadonlySet<string> = new Set(['published', 'superseded'])

type Available = Extract<ResolvedSketchLink, { state: 'available' }>
/** What one target adds to its link; the place is its document's. */
type Facts = Omit<Available, keyof SketchOutlineLink | 'state' | 'place'>
/** One lookup's answer per target id; a lookup that failed answers nothing. */
type ById = ReadonlyMap<string, Facts>

const causeOf = (error: unknown) => (error instanceof Error ? `${error.name}: ${error.message}` : 'unknown')

/**
 * `work`'s answer, or `fallback` when it throws. A refusal (`ApiError`: no access,
 * models off for the office) is the reader's answer and says nothing; anything
 * else is a fault, logged, and still only this lookup's links go unavailable.
 */
async function orElse<T>(what: string, documentId: string, fallback: T, work: () => Promise<T>): Promise<T> {
  try {
    return await work()
  } catch (error) {
    if (!(error instanceof ApiError)) console.error('[diagrams] a sketch link could not be resolved', { what, documentId, cause: causeOf(error) })
    return fallback
  }
}

const nameOf = (document: Document) => document.displayName ?? document.filename

function placeOf(document: Document): SketchLinkPlace | null {
  if (document.scope === 'office_shelf') return { shelf: 'office_shelf', projectId: null, documentId: document.id }
  if (document.scope === 'project' && document.projectId) return { shelf: 'project', projectId: document.projectId, documentId: document.id }
  // A chat attachment has no shelf to open it on.
  return null
}

const distinct = (values: (string | undefined)[]) => [...new Set(values.filter((value): value is string => Boolean(value)))]

async function versionFacts(session: AuthorizedSession, document: Document, versionIds: string[]): Promise<ById> {
  const rows = (await listPinnedVersions(session.organizationId, document.id, versionIds)).filter((row) => SHOWN_VERSION_STATES.has(row.state))
  if (rows.length === 0) return new Map()
  const readable = await versionBytesReadableBy(session, document, rows)
  return new Map(
    rows.filter(readable).map((row): [string, Facts] => [row.id, { title: nameOf(document), versionNumber: row.versionNumber, current: row.id === document.publishedVersionId }])
  )
}

async function annotationFacts(session: AuthorizedSession, document: Document, annotationIds: string[]): Promise<ById> {
  const rows = await listAnnotationHeads(session.organizationId, document.id, annotationIds)
  return new Map(
    rows.map((row): [string, Facts] => {
      const body = row.body.replace(/\s+/g, ' ').trim()
      const title = body.length > ANNOTATION_TITLE_CHARS ? `${body.slice(0, ANNOTATION_TITLE_CHARS - 1)}…` : body
      return [row.id, { title, status: row.status, annotationKind: row.kind }]
    })
  )
}

async function elementFacts(session: AuthorizedSession, document: Document, globalIds: string[]): Promise<ById> {
  const found = await findElementsOfReadDocument(session, document, globalIds)
  if (!found) return new Map()
  const { model, elements } = found
  return new Map(
    elements.map((element): [string, Facts] => [
      element.globalId,
      { title: element.name ? `${element.name} (${element.ifcType})` : element.ifcType, modelFile: model.filename },
    ])
  )
}

/** Every link naming one document, as `session` sees them: one access check, one query per kind of target. */
async function resolveDocument(session: AuthorizedSession, documentId: string, links: readonly SketchOutlineLink[]): Promise<ResolvedSketchLink[]> {
  const unavailable = (link: SketchOutlineLink): ResolvedSketchLink => ({ ...link, state: 'unavailable' })
  const document = await orElse('document', documentId, null, () => getAccessibleDocument(session, documentId, 'read'))
  const place = document ? placeOf(document) : null
  if (!document || !place) return links.map(unavailable)
  const none: ById = new Map()
  const versionIds = distinct(links.map((link) => (link.kind === 'document' ? link.ref.versionId : undefined)))
  const annotationIds = distinct(links.map((link) => (link.kind === 'annotation' ? link.ref.annotationId : undefined)))
  const globalIds = distinct(links.map((link) => (link.kind === 'ifcElement' ? link.ref.ifcGlobalId : undefined)))
  const versions = versionIds.length ? await orElse('version', documentId, none, () => versionFacts(session, document, versionIds)) : none
  const annotations = annotationIds.length ? await orElse('annotation', documentId, none, () => annotationFacts(session, document, annotationIds)) : none
  const elements = globalIds.length ? await orElse('element', documentId, none, () => elementFacts(session, document, globalIds)) : none
  const onDocument: Facts = { title: nameOf(document) }
  return links.map((link): ResolvedSketchLink => {
    const { page, versionId, annotationId, ifcGlobalId } = link.ref
    const target =
      link.kind === 'annotation'
        ? annotations.get(annotationId as string)
        : link.kind === 'ifcElement'
          ? elements.get(ifcGlobalId as string)
          : versionId
            ? versions.get(versionId)
            : onDocument
    if (!target) return unavailable(link)
    return { ...link, state: 'available', ...target, ...(link.kind === 'document' && page ? { page } : {}), place }
  })
}

/** Each link as `session` sees it, in the order given. */
export async function resolveSketchLinks(session: AuthorizedSession, links: readonly SketchOutlineLink[]): Promise<ResolvedSketchLink[]> {
  const resolving = links.slice(0, MAX_RESOLVED_SKETCH_LINKS)
  const byDocument = new Map<string, SketchOutlineLink[]>()
  for (const link of resolving) byDocument.set(link.ref.documentId, [...(byDocument.get(link.ref.documentId) ?? []), link])
  const groups = [...byDocument.entries()]
  const answers = await inPool(groups, SKETCH_LINK_DOCUMENTS_AT_ONCE, ([documentId, group]) => resolveDocument(session, documentId, group))
  const resolved = new Map<SketchOutlineLink, ResolvedSketchLink>()
  groups.forEach(([, group], index) => group.forEach((link, at) => resolved.set(link, answers[index][at])))
  return links.map((link): ResolvedSketchLink => resolved.get(link) ?? { ...link, state: 'unavailable' })
}
