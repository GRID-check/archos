/**
 * What a project's documents say about each other, derived on read from the
 * project's documents list (`docs/architecture/document-dossier.md`,
 * „Findings“). Pure: no I/O, no clock, so the route, the agent operation and
 * a dev preview compute the same findings from the same rows.
 *
 * A finding is a pointer for a person, never a verdict: every one names the
 * documents and pages it rests on, so the reader can look for themselves.
 *
 * Four kinds:
 *  - `missing_document`: a current document points at a document type no
 *    document in the project has (by its dossier type or its tags).
 *  - `missing_plan`: a current document points at a drawing number no
 *    document's title block number or file name matches.
 *  - `contradiction`: two current documents state one fact key with values
 *    that do not overlap.
 *  - `incomplete_read`: a current document has pages no chunk holds.
 *
 * "Current" is not superseded by a newer Fassung: a replaced document's claims
 * and gaps are history. A target, though, may be any document of the project,
 * replaced or not, because it is there to be opened.
 */

import { DOCUMENT_TYPE_TAGS } from './tag-vocabulary'
import type {
  CoverageReason,
  DocumentReference,
  Dossier,
  DossierDocumentType,
  DossierFactKey,
  ReadingCoverage,
} from './dossier'

/** One document as the findings read it: what the listing row carries, narrowed. */
export interface FindingsDocument {
  id: string
  /** What a person calls it: the rename, else the file name. */
  name: string
  filename: string
  /** A newer Fassung replaces it (`revision.supersededBy`). */
  superseded: boolean
  tags: readonly string[]
  dossier: Dossier | null
  references: readonly DocumentReference[]
  coverage: ReadingCoverage | null
  /** The title block's drawing number (`revisionFacts.documentNumber`). */
  documentNumber: string | null
}

/** What a listing row (`ListedDocument`) or a file item (`FileItem`) carries that the findings read. */
export interface FindingsRow {
  id: string
  filename: string
  displayName?: string | null
  tags?: readonly string[] | null
  dossier?: Dossier | null
  docReferences?: readonly DocumentReference[] | null
  coverage?: ReadingCoverage | null
  revisionFacts?: { documentNumber?: string } | null
  revision?: { supersededBy: unknown } | null
}

/** One row as the findings read it. */
export function toFindingsDocument(row: FindingsRow): FindingsDocument {
  return {
    id: row.id,
    name: row.displayName ?? row.filename,
    filename: row.filename,
    superseded: Boolean(row.revision?.supersededBy),
    tags: row.tags ?? [],
    dossier: row.dossier ?? null,
    references: row.docReferences ?? [],
    coverage: row.coverage ?? null,
    documentNumber: row.revisionFacts?.documentNumber ?? null,
  }
}

/** A document a finding or a reference points at. */
export interface DocumentPointer {
  documentId: string
  name: string
}

/** One document a finding rests on, and where in it. */
export interface FindingSource extends DocumentPointer {
  /** 1-based, ascending; empty when the document does not say. */
  pages: number[]
  /** For a contradiction: the value this document states, as it writes it. */
  value?: string
  unit?: string | null
}

export const DOCUMENT_FINDING_KINDS = ['contradiction', 'missing_document', 'missing_plan', 'incomplete_read'] as const
export type DocumentFindingKind = (typeof DOCUMENT_FINDING_KINDS)[number]

export type DocumentFinding =
  | { kind: 'missing_document'; documentType: DossierDocumentType; label: string; sources: FindingSource[] }
  | { kind: 'missing_plan'; key: string; label: string; sources: FindingSource[] }
  | { kind: 'contradiction'; factKey: DossierFactKey; sources: FindingSource[] }
  | {
      kind: 'incomplete_read'
      pages: number
      notRead: number
      reasons: Partial<Record<CoverageReason, number>>
      sources: FindingSource[]
    }

/**
 * One reference of a document, resolved against the project. `external` is a
 * norm or a law (not a project document); `self` points only at the document
 * itself (a Baubeschreibung naming the Baubeschreibung), which says nothing.
 */
export interface ResolvedReference {
  reference: DocumentReference
  resolution: 'resolved' | 'missing' | 'self' | 'external'
  targets: DocumentPointer[]
}

/** A document that points at another one, and with what. */
export interface IncomingReference {
  source: DocumentPointer
  reference: DocumentReference
}

type TagName = (typeof DOCUMENT_TYPE_TAGS)[number]

/**
 * The document types a controlled tag stands for (`document_classification.py`,
 * `DOCUMENT_TYPE_TAGS`). A tag is coarser than a dossier type: a Grundriss is
 * taken for a submission drawing, the commonest kind a project holds.
 * „Sonstiges“ stands for nothing.
 */
const TAG_DOCUMENT_TYPES: ReadonlyMap<TagName, readonly DossierDocumentType[]> = new Map<
  TagName,
  readonly DossierDocumentType[]
>([
  ['Bebauungsplan', ['zoning_plan']],
  ['Flächenwidmungsplan', ['zoning_plan']],
  ['Grundriss', ['submission_drawing']],
  ['Schnitt', ['submission_drawing']],
  ['Ansicht', ['submission_drawing']],
  ['Detail', ['construction_drawing']],
  ['Gutachten', ['expert_report']],
  ['Bescheid', ['permit']],
  ['Norm/Richtlinie', ['legal_text']],
  ['Vertrag', ['contract']],
  ['Foto', ['photo']],
])

/** A Gutachten with this discipline tag is the specific report. */
const REPORT_BY_DISCIPLINE: ReadonlyMap<string, DossierDocumentType> = new Map([
  ['Brandschutz', 'fire_safety_concept'],
  ['Standsicherheit', 'structural_analysis'],
])

/** A reference to the broad type is answered by any of the specific ones. */
const ANSWERED_BY: Partial<Record<DossierDocumentType, readonly DossierDocumentType[]>> = {
  expert_report: ['soil_report', 'building_physics', 'fire_safety_concept', 'structural_analysis', 'energy_certificate'],
}

/** The document types one document is, from its dossier and its tags. */
export function documentTypesOf(document: Pick<FindingsDocument, 'dossier' | 'tags'>): Set<DossierDocumentType> {
  const types = new Set<DossierDocumentType>()
  if (document.dossier?.documentType) types.add(document.dossier.documentType)
  for (const tag of document.tags) {
    for (const type of TAG_DOCUMENT_TYPES.get(tag as TagName) ?? []) types.add(type)
  }
  if (document.tags.includes('Gutachten')) {
    for (const tag of document.tags) {
      const report = REPORT_BY_DISCIPLINE.get(tag)
      if (report) types.add(report)
    }
  }
  return types
}

/** Lowercase, and without the spaces, hyphens and underscores a drawing number is written with or without. */
export function squashDrawingNumber(value: string): string {
  return value.normalize('NFC').toLowerCase().replace(/[\s\-_]+/g, '')
}

const escapeRegExp = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/**
 * Does the file name carry the drawing number? „EP-05“ matches
 * `EP05_Grundriss_EG.pdf` and `ep 05 Grundriss.pdf`, never `EP-050.pdf`
 * or `STEP-05.pdf`: the number stands on its own in the name.
 */
function fileNameCarries(filename: string, squashedKey: string): boolean {
  if (squashedKey.length < 2) return false
  const pattern = [...squashedKey].map(escapeRegExp).join('[\\s\\-_.]*')
  return new RegExp(`(?<![\\p{L}\\p{N}])${pattern}(?!\\p{N})`, 'iu').test(filename.normalize('NFC'))
}

/** The squashed forms a drawing reference may be found under: the key, and for „3/A-501“ the sheet `A-501`. */
function drawingKeys(reference: DocumentReference): string[] {
  const keys = [squashDrawingNumber(reference.key)]
  const sheet = reference.key.split('/').at(-1)
  if (sheet && sheet !== reference.key) keys.push(squashDrawingNumber(sheet))
  return keys.filter((key) => key.length > 0)
}

const pointer = (document: FindingsDocument): DocumentPointer => ({ documentId: document.id, name: document.name })

/**
 * The documents of the project one reference points at. A norm or a law is no
 * project document; a drawing number is matched against the title block's
 * number, then the file name; a document type against types and tags.
 */
function targetsOf(reference: DocumentReference, documents: readonly FindingsDocument[]): FindingsDocument[] | null {
  if (reference.kind === 'norm' || reference.kind === 'law') return null
  if (reference.kind === 'document') {
    const wanted = new Set<string>([reference.key, ...(ANSWERED_BY[reference.key as DossierDocumentType] ?? [])])
    return documents.filter((document) => [...documentTypesOf(document)].some((type) => wanted.has(type)))
  }
  const keys = drawingKeys(reference)
  const byNumber = documents.filter(
    (document) => document.documentNumber !== null && keys.includes(squashDrawingNumber(document.documentNumber))
  )
  if (byNumber.length > 0) return byNumber
  return documents.filter((document) => keys.some((key) => fileNameCarries(document.filename, key)))
}

/** Every reference of `document`, resolved against the project's `documents`. */
export function resolveReferences(
  document: FindingsDocument,
  documents: readonly FindingsDocument[]
): ResolvedReference[] {
  return document.references.map((reference) => {
    const found = targetsOf(reference, documents)
    if (found === null) return { reference, resolution: 'external', targets: [] }
    const others = found.filter((target) => target.id !== document.id)
    if (others.length > 0) return { reference, resolution: 'resolved', targets: others.map(pointer) }
    return { reference, resolution: found.length > 0 ? 'self' : 'missing', targets: [] }
  })
}

/** The documents that point at `document` with a drawing number or a document type it answers. */
export function referencedBy(document: FindingsDocument, documents: readonly FindingsDocument[]): IncomingReference[] {
  const incoming: IncomingReference[] = []
  for (const source of documents) {
    if (source.id === document.id) continue
    for (const reference of source.references) {
      const found = targetsOf(reference, [document])
      if (found && found.length > 0) incoming.push({ source: pointer(source), reference })
    }
  }
  return incoming
}

/** A fact value as two documents could write it alike: trimmed, one case, decimal comma as dot, `4.0` as `4`. */
export function normalizeFactValue(value: string): string {
  const text = value.normalize('NFC').trim().replace(/\s+/g, ' ').toLowerCase().replace(/(\d),(\d)/g, '$1.$2')
  return /^-?\d+(\.\d+)?$/.test(text) ? String(Number(text)) : text
}

const byName = (a: DocumentPointer, b: DocumentPointer): number => a.name.localeCompare(b.name, 'de')

/** Group the references of current documents that resolve to nothing, one finding per target. */
function missingFindings(current: readonly FindingsDocument[], documents: readonly FindingsDocument[]): DocumentFinding[] {
  const missing = new Map<string, { reference: DocumentReference; sources: FindingSource[] }>()
  for (const document of current) {
    for (const reference of document.references) {
      if (reference.kind !== 'document' && reference.kind !== 'plan') continue
      const found = targetsOf(reference, documents)
      if (found === null || found.length > 0) continue
      const identity = `${reference.kind}\u0000${reference.kind === 'plan' ? drawingKeys(reference)[0] : reference.key}`
      const entry = missing.get(identity) ?? { reference, sources: [] }
      entry.sources.push({ ...pointer(document), pages: reference.pages })
      missing.set(identity, entry)
    }
  }
  return [...missing.values()].map(({ reference, sources }) =>
    reference.kind === 'document'
      ? {
          kind: 'missing_document' as const,
          documentType: reference.key as DossierDocumentType,
          label: reference.label,
          sources: sources.sort(byName),
        }
      : { kind: 'missing_plan' as const, key: reference.key, label: reference.label, sources: sources.sort(byName) }
  )
}

/**
 * One finding per fact key on which two current documents state values that
 * do not overlap. A document may state a key more than once (a room height
 * per storey); it disagrees with another only when they share no value.
 */
function contradictionFindings(current: readonly FindingsDocument[]): DocumentFinding[] {
  const byKey = new Map<DossierFactKey, Map<string, Map<string, FindingSource>>>()
  for (const document of current) {
    for (const fact of document.dossier?.facts ?? []) {
      const normalized = normalizeFactValue(fact.value)
      const perDocument = byKey.get(fact.key) ?? new Map<string, Map<string, FindingSource>>()
      const values = perDocument.get(document.id) ?? new Map<string, FindingSource>()
      const source = values.get(normalized) ?? { ...pointer(document), pages: [], value: fact.value, unit: fact.unit }
      if (fact.page !== null && !source.pages.includes(fact.page)) source.pages = [...source.pages, fact.page].sort((a, b) => a - b)
      values.set(normalized, source)
      perDocument.set(document.id, values)
      byKey.set(fact.key, perDocument)
    }
  }
  const findings: DocumentFinding[] = []
  for (const [factKey, perDocument] of byKey) {
    const sets = [...perDocument.values()].map((values) => new Set(values.keys()))
    const disagree = sets.some((a, i) => sets.slice(i + 1).some((b) => ![...a].some((value) => b.has(value))))
    if (!disagree) continue
    const sources = [...perDocument.values()].flatMap((values) => [...values.values()]).sort(byName)
    findings.push({ kind: 'contradiction', factKey, sources })
  }
  return findings
}

function incompleteReadFindings(current: readonly FindingsDocument[]): DocumentFinding[] {
  return current
    .filter((document) => (document.coverage?.notRead ?? 0) > 0)
    .sort(byNamePointer)
    .map((document) => {
      const coverage = document.coverage as ReadingCoverage
      return {
        kind: 'incomplete_read' as const,
        pages: coverage.pages,
        notRead: coverage.notRead,
        reasons: coverage.reasons,
        sources: [{ ...pointer(document), pages: [] }],
      }
    })
}

const byNamePointer = (a: FindingsDocument, b: FindingsDocument): number => a.name.localeCompare(b.name, 'de')

/**
 * Every finding over a project's documents, contradictions first (they ask
 * for a decision), then what is missing, then what was not read.
 */
export function deriveDocumentFindings(documents: readonly FindingsDocument[]): DocumentFinding[] {
  const current = documents.filter((document) => !document.superseded)
  const rank = (finding: DocumentFinding): number => DOCUMENT_FINDING_KINDS.indexOf(finding.kind)
  return [...contradictionFindings(current), ...missingFindings(current, documents), ...incompleteReadFindings(current)].sort(
    (a, b) => rank(a) - rank(b)
  )
}

/** Does this finding rest on the document? */
export function findingConcerns(finding: DocumentFinding, documentId: string): boolean {
  return finding.sources.some((source) => source.documentId === documentId)
}
