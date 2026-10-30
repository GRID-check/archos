/**
 * A Skizze's links as one reader sees them (S5, `sketch-links.ts`).
 *
 * The scene stores ids; this asks, with the reader's own rights, what each id is
 * for them. Every target goes through the door its own surface uses: a document
 * through `getAccessibleDocument` (the shelf's rule, a folder the reader may not
 * see, a held upload), a model element through the model service
 * (`getModelForDocument`, then the element query a viewer asks), an Anmerkung
 * through its document and then its row. A target that is gone, or that this
 * reader may not open, is `unavailable` and nothing more: no title, no reason,
 * so the sketch says nothing of a document its reader cannot see.
 *
 * The answer is a reading: nothing here is stored, and nothing a reader learns
 * from one link reaches the scene, the search row (`sketch-search.ts`, which
 * indexes no link) or another reader.
 */

import 'server-only'
import { ApiError } from '@/lib/api/errors'
import type { AuthorizedSession } from '@/lib/auth/types'
import { findDocumentAnnotation } from '@/lib/annotations/repository'
import { getModelForDocument, queryAccessibleModel } from '@/lib/bim/model-service'
import type { Document } from '@/lib/db/schema/documents'
import { getAccessibleDocument } from '@/lib/documents/access'
import { findDocumentVersion } from '@/lib/documents/version-repository'
import type { ResolvedSketchLink, SketchLinkPlace, SketchOutlineLink } from './sketch-links'

/** At most this many links are resolved on one read; the rest read as unavailable. A sketch is a page, not a register. */
export const MAX_RESOLVED_SKETCH_LINKS = 60

const ANNOTATION_TITLE_CHARS = 80

type Available = Extract<ResolvedSketchLink, { state: 'available' }>
type Facts = Omit<Available, keyof SketchOutlineLink | 'state'>

/** The document if this reader may open it, else null. A refusal of access and a missing row read alike. */
async function readable(session: AuthorizedSession, documentId: string): Promise<Document | null> {
  try {
    return await getAccessibleDocument(session, documentId, 'read')
  } catch (error) {
    if (error instanceof ApiError) return null
    throw error
  }
}

const nameOf = (document: Document) => document.displayName ?? document.filename

function placeOf(document: Document): SketchLinkPlace | null {
  if (document.scope === 'office_shelf') return { shelf: 'office_shelf', projectId: null, documentId: document.id }
  if (document.scope === 'project' && document.projectId) return { shelf: 'project', projectId: document.projectId, documentId: document.id }
  // A chat attachment has no shelf to open it on.
  return null
}

async function documentFacts(session: AuthorizedSession, link: SketchOutlineLink, document: Document, place: SketchLinkPlace): Promise<Facts | null> {
  const { versionId, page } = link.ref
  const facts: Facts = { title: nameOf(document), place, ...(page ? { page } : {}) }
  if (!versionId) return facts
  const version = await findDocumentVersion(versionId, document.id, session.organizationId)
  if (!version) return null
  return { ...facts, versionNumber: version.versionNumber, current: version.id === document.publishedVersionId }
}

async function elementFacts(session: AuthorizedSession, link: SketchOutlineLink, document: Document, place: SketchLinkPlace): Promise<Facts | null> {
  const globalId = link.ref.ifcGlobalId as string
  const model = await getModelForDocument(session, document.id)
  if (!model || model.status !== 'ready') return null
  const result = await queryAccessibleModel(session, model.id, { op: 'element', globalId })
  const element = 'element' in result ? (result.element as { name: string | null; ifcType: string } | null) : null
  if (!element) return null
  return { title: element.name ? `${element.name} (${element.ifcType})` : element.ifcType, place, modelFile: model.filename }
}

async function annotationFacts(session: AuthorizedSession, link: SketchOutlineLink, document: Document, place: SketchLinkPlace): Promise<Facts | null> {
  const record = await findDocumentAnnotation(session.organizationId, document.id, link.ref.annotationId as string)
  if (!record) return null
  const body = record.body.replace(/\s+/g, ' ').trim()
  const title = body.length > ANNOTATION_TITLE_CHARS ? `${body.slice(0, ANNOTATION_TITLE_CHARS - 1)}…` : body
  return { title, place, status: record.status, annotationKind: record.kind }
}

const FACTS = { document: documentFacts, ifcElement: elementFacts, annotation: annotationFacts } as const

async function resolveOne(session: AuthorizedSession, link: SketchOutlineLink): Promise<ResolvedSketchLink> {
  const unavailable: ResolvedSketchLink = { ...link, state: 'unavailable' }
  try {
    const document = await readable(session, link.ref.documentId)
    const place = document ? placeOf(document) : null
    if (!document || !place) return unavailable
    const facts = await FACTS[link.kind](session, link, document, place)
    return facts ? { ...link, state: 'available', ...facts } : unavailable
  } catch (error) {
    // A model service switched off for the office, a model the reader cannot open: unavailable to them.
    if (error instanceof ApiError) return unavailable
    throw error
  }
}

/** Each link as `session` sees it, in the order given. */
export async function resolveSketchLinks(session: AuthorizedSession, links: readonly SketchOutlineLink[]): Promise<ResolvedSketchLink[]> {
  const resolving = links.slice(0, MAX_RESOLVED_SKETCH_LINKS)
  const resolved = await Promise.all(resolving.map((link) => resolveOne(session, link)))
  return [...resolved, ...links.slice(MAX_RESOLVED_SKETCH_LINKS).map((link): ResolvedSketchLink => ({ ...link, state: 'unavailable' }))]
}
