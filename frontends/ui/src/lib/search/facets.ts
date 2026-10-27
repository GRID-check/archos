/**
 * A document's reading as its search row (`document_search_facets`, ADR-0136).
 * Pure: the projector and the specs call it with what the listing parsed.
 *
 * The tokens are the Qdrant payload's own (`knowledge_layer/qdrant/payload.py`,
 * `reference_value` and `fact_value`), so a filter means the same thing on the
 * structured path and on the content search's pre-filter: a reference is
 * `kind:key` in lower case, a fact is `key=value` with the value folded (case,
 * spaces, decimal comma, a Gebäudeklasse written „GK 4“ or „IV“ as its number).
 * The payload's fact token also carries the unit; ours does not, because a
 * filter asks for a value, and the unit stays on the fact for display.
 */

import { createHash } from 'node:crypto'
import type { NewDocumentSearchFacetsRow, SearchFacetFact, SearchFacetParty } from '@/lib/db/schema'
import type { DocumentMetadata } from '@/lib/documents/reconcile-status'
import { squashDrawingNumber } from '@/lib/documents/findings'

/** What the projector knows of one document besides its reading. */
export interface FacetSubject {
  documentId: string
  organizationId: string
  /** A newer Fassung replaces it (the listing's `superseded_by`). */
  superseded: boolean
}

/** The longest `search_text`, as the migration's CHECK bounds it. */
export const SEARCH_TEXT_MAX = 20_000

const ROMAN: Record<string, string> = { i: '1', ii: '2', iii: '3', iv: '4', v: '5' }

const collapse = (value: string): string => value.normalize('NFC').split(/\s+/).filter(Boolean).join(' ')

/** One reference as the payload's `references` holds it: `norm:önorm b 1600`, `plan:ep-05`. */
export function referenceToken(kind: string, key: string): string {
  return `${kind}:${key}`.normalize('NFC').toLowerCase()
}

/** A fact's value folded as the payload's `fact_value` folds it, without the unit. */
export function foldFactValue(key: string, value: string): string {
  let text = collapse(value).toLowerCase().replace(/,/g, '.')
  if (key === 'building_class') {
    const words = text.split(' ')
    const last = words.at(-1) ?? text
    text = ROMAN[last] ?? (text.replace(/\D/g, '') || text)
  }
  return text
}

/** `key=value`, the token a fact filter matches. */
export function factToken(key: string, value: string): string {
  return `${key}=${foldFactValue(key, value)}`
}

/** The number a fact states, for a range: its folded value when it starts with one. */
export function factNumber(key: string, value: string): number | null {
  const match = /^-?\d+(\.\d+)?/.exec(foldFactValue(key, value))
  if (!match) return null
  const number = Number(match[0])
  return Number.isFinite(number) ? number : null
}

/** The document's own date: the dossier's issue or plan date, else the Plankopf's. */
function documentDateOf(metadata: DocumentMetadata): string | null {
  const dates = metadata.dossier?.dates ?? []
  return (
    dates.find((date) => date.kind === 'issued')?.date ??
    dates.find((date) => date.kind === 'plan_date')?.date ??
    metadata.revisionFacts?.revisionDate ??
    null
  )
}

/** A capture time a timestamp column takes, or null for one the camera wrote unreadably. */
function capturedAtOf(raw: string | undefined): Date | null {
  if (!raw) return null
  // EXIF writes `2026:09:14 10:31:00`; the backend may already send ISO.
  const iso = raw.replace(/^(\d{4}):(\d{2}):(\d{2})[ T]/, '$1-$2-$3T')
  const date = new Date(iso)
  return Number.isNaN(date.getTime()) ? null : date
}

/**
 * Whether the listing said anything about this document's reading. A listing
 * read while the agent's metadata store failed answers 200 with none of it, and
 * must not blank a row (ADR-0136, the projector fails closed).
 */
export function hasReading(metadata: DocumentMetadata | null | undefined): metadata is DocumentMetadata {
  if (!metadata) return false
  return Boolean(
    metadata.summary ||
      metadata.dossier ||
      metadata.revisionFacts ||
      metadata.capture ||
      (metadata.tags && metadata.tags.length > 0) ||
      metadata.coverage
  )
}

/** The text the full-text vector is built from: what the document says it is, not its file name. */
function searchTextOf(row: Omit<NewDocumentSearchFacetsRow, 'searchText' | 'fingerprint'>, revisionTitle: string | undefined): string {
  const parts = [
    row.title,
    revisionTitle,
    row.summary,
    ...(row.parties ?? []).map((party) => party.name),
    row.address,
    row.municipality,
    row.planNumber,
    ...Object.values(row.referenceLabels ?? {}),
    ...(row.topics ?? []),
  ]
  return collapse(parts.filter((part): part is string => typeof part === 'string' && part.length > 0).join(' · ')).slice(
    0,
    SEARCH_TEXT_MAX
  )
}

/** The hash of what a row says, so an unchanged row is not rewritten. */
function fingerprintOf(row: Omit<NewDocumentSearchFacetsRow, 'fingerprint'>): string {
  const { syncedAt: _synced, ...said } = row
  return createHash('sha256').update(JSON.stringify(said)).digest('hex').slice(0, 32)
}

/**
 * The search row of one document, or `null` when the listing said nothing of
 * its reading (the caller then leaves any stored row as it is).
 */
export function toSearchFacets(
  subject: FacetSubject,
  metadata: DocumentMetadata | null | undefined
): NewDocumentSearchFacetsRow | null {
  if (!hasReading(metadata)) return null
  const dossier = metadata.dossier ?? null
  const revision = metadata.revisionFacts ?? null
  const parties: SearchFacetParty[] = (dossier?.parties ?? []).map((party) => ({ role: party.role, name: party.name }))
  const facts: SearchFacetFact[] = (dossier?.facts ?? []).map((fact) => ({
    key: fact.key,
    value: fact.value,
    unit: fact.unit,
    page: fact.page,
  }))
  const factNumbers: Record<string, number> = {}
  for (const fact of facts) {
    const number = factNumber(fact.key, fact.value)
    if (number !== null && !(fact.key in factNumbers)) factNumbers[fact.key] = number
  }
  const references = metadata.docReferences ?? []
  const referenceLabels: Record<string, string> = {}
  for (const reference of references) {
    const token = referenceToken(reference.kind, reference.key)
    if (!(token in referenceLabels)) referenceLabels[token] = reference.label
  }
  const capture = metadata.capture ?? null
  const base = {
    documentId: subject.documentId,
    organizationId: subject.organizationId,
    documentType: dossier?.documentType ?? null,
    tags: [...new Set(metadata.tags ?? [])],
    topics: [...new Set(metadata.topics ?? [])],
    title: dossier?.title ?? revision?.title ?? null,
    summary: dossier?.summary ?? metadata.summary ?? null,
    parties,
    partyRoles: [...new Set(parties.map((party) => party.role))],
    address: dossier?.place?.address ?? null,
    municipality: dossier?.place?.municipality ?? null,
    federalState: dossier?.place?.state ?? null,
    facts,
    factTokens: [...new Set(facts.map((fact) => factToken(fact.key, fact.value)))],
    factNumbers,
    referenceTokens: Object.keys(referenceLabels),
    referenceLabels,
    planNumber: revision?.documentNumber ?? null,
    planNumberKey: revision?.documentNumber ? squashDrawingNumber(revision.documentNumber) : null,
    planIndex: revision?.revision ?? null,
    planDate: revision?.revisionDate ?? null,
    scale: revision?.scale ?? null,
    documentDate: documentDateOf(metadata),
    capturedAt: capturedAtOf(capture?.capturedAt),
    camera: capture?.camera ?? null,
    pageCount: metadata.pageCount ?? metadata.coverage?.pages ?? null,
    pagesNotRead: metadata.coverage ? metadata.coverage.notRead : null,
    superseded: subject.superseded,
  } satisfies Omit<NewDocumentSearchFacetsRow, 'searchText' | 'fingerprint'>
  const withText = { ...base, searchText: searchTextOf(base, revision?.title) }
  return { ...withText, fingerprint: fingerprintOf(withText) }
}
