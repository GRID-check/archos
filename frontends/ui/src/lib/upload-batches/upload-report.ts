/**
 * The Eingangsbericht: what one upload brought the project
 * (`docs/roadmap/ingestion-north-star.md`, "an ingestion is a job that looks
 * at what this upload provides for the project"). Pure: the settle computes it
 * from the project's documents as the uploader may see them
 * (`./upload-report-service`), the inbox row renders it, and a dev preview
 * computes the same report from fixtures.
 *
 * It names no document. It counts them, by the dossier's document type, and
 * names what the findings name: a document type, a drawing number, a fact key.
 * The report is frozen on the `upload.completed` row while the documents live
 * on, so a name in it could outlive the reader's right to see the file; counts
 * and keys say what changed, and the findings panel the row links to shows the
 * documents, re-authorized on every read.
 *
 * "New" findings are a diff: the findings of the project without the batch's
 * documents against those with them. A document this upload replaced keeps its
 * id (ADR-0054), so its older Fassung is in neither side; a finding only the
 * older Fassung carried is then counted neither new nor resolved.
 */

import { z } from 'zod'
import {
  DOSSIER_DOCUMENT_TYPES,
  DOSSIER_FACT_KEYS,
  type DossierDocumentType,
  type DossierFactKey,
} from '@/lib/documents/dossier'
import {
  deriveDocumentFindings,
  DOCUMENT_FINDING_KINDS,
  documentTypesOf,
  findingIdentity,
  resolveReferences,
  type DocumentFinding,
  type FindingsDocument,
} from '@/lib/documents/findings'
import type { ProfileFacts } from '@/lib/documents/profile-contradictions'

/** How much of each list the report keeps: an inbox row is a glance, the panel is the rest. */
export const UPLOAD_REPORT_LIMITS = { types: 8, facts: 6, findings: 5 } as const

const count = z.number().int().min(0).max(100_000)

/** One finding the upload brought, as the row names it. */
const uploadReportFindingSchema = z.object({
  kind: z.enum(DOCUMENT_FINDING_KINDS),
  /** The fact key, the document type, the profile subject or the drawing number. */
  key: z.string().min(1).max(120),
  /** A drawing number as the document writes it; null for the other kinds. */
  label: z.string().max(120).nullable(),
  /** How many documents the finding rests on. */
  documents: count,
})

/**
 * The report as the `upload.completed` payload carries it (`payload.report`),
 * and as the inbox read path parses it back: a payload is never trusted, so a
 * row whose report does not parse shows none.
 */
export const uploadReportSchema = z.object({
  projectId: z.string().min(1).max(64),
  /** The batch's documents the uploader may see on the shelf. */
  documents: count,
  /** Of those, the ones Piloti read: a dossier or a reading coverage. */
  read: count,
  byType: z
    .array(z.object({ type: z.enum(DOSSIER_DOCUMENT_TYPES), count }))
    .max(UPLOAD_REPORT_LIMITS.types),
  /** Facts the batch's documents state, all of them. */
  facts: count,
  /** One per fact key, in the dossier's key order, as the document writes it. */
  factSamples: z
    .array(
      z.object({ key: z.enum(DOSSIER_FACT_KEYS), value: z.string().max(120), unit: z.string().max(24).nullable() })
    )
    .max(UPLOAD_REPORT_LIMITS.facts),
  /** Findings the project has because of this upload, all of them. */
  newFindings: count,
  findings: z.array(uploadReportFindingSchema).max(UPLOAD_REPORT_LIMITS.findings),
  /** Findings the project no longer has because of it: the Bodengutachten that came. */
  resolvedFindings: count,
  /** Distinct references to a document or a drawing number the project does not hold. */
  unresolvedReferences: count,
  pagesNotRead: count,
  documentsNotFullyRead: count,
})

export type UploadReport = z.infer<typeof uploadReportSchema>
export type UploadReportFinding = z.infer<typeof uploadReportFindingSchema>

/** A report as the pure function derives it; the service adds the project. */
export type UploadReportSummary = Omit<UploadReport, 'projectId'>

/** A stored payload's report, or null when it is absent or does not parse. */
export function parseUploadReport(value: unknown): UploadReport | null {
  const parsed = uploadReportSchema.safeParse(value)
  return parsed.success ? parsed.data : null
}

/** The type a document is counted under: its dossier's, else the first its tags stand for. */
function countedType(document: FindingsDocument): DossierDocumentType | null {
  if (document.dossier?.documentType) return document.dossier.documentType
  const [first] = [...documentTypesOf(document)].sort(
    (a, b) => DOSSIER_DOCUMENT_TYPES.indexOf(a) - DOSSIER_DOCUMENT_TYPES.indexOf(b)
  )
  return first ?? null
}

function typeCounts(documents: readonly FindingsDocument[]): UploadReport['byType'] {
  const counts = new Map<DossierDocumentType, number>()
  for (const document of documents) {
    const type = countedType(document)
    if (type) counts.set(type, (counts.get(type) ?? 0) + 1)
  }
  return [...counts.entries()]
    .sort(([a, x], [b, y]) => y - x || DOSSIER_DOCUMENT_TYPES.indexOf(a) - DOSSIER_DOCUMENT_TYPES.indexOf(b))
    .slice(0, UPLOAD_REPORT_LIMITS.types)
    .map(([type, total]) => ({ type, count: total }))
}

function factSamples(documents: readonly FindingsDocument[]): UploadReport['factSamples'] {
  const first = new Map<DossierFactKey, UploadReport['factSamples'][number]>()
  for (const document of documents) {
    for (const fact of document.dossier?.facts ?? []) {
      if (!first.has(fact.key)) first.set(fact.key, { key: fact.key, value: fact.value, unit: fact.unit })
    }
  }
  return [...first.values()]
    .sort((a, b) => DOSSIER_FACT_KEYS.indexOf(a.key) - DOSSIER_FACT_KEYS.indexOf(b.key))
    .slice(0, UPLOAD_REPORT_LIMITS.facts)
}

/** A finding as the row names it; `incomplete_read` is the pages line, not a finding line. */
function reportFinding(finding: DocumentFinding): UploadReportFinding | null {
  const documents = new Set(finding.sources.map((source) => source.documentId)).size
  switch (finding.kind) {
    case 'profile_contradiction':
      return { kind: finding.kind, key: finding.subject, label: null, documents }
    case 'contradiction':
      return { kind: finding.kind, key: finding.factKey, label: null, documents }
    case 'missing_document':
      return { kind: finding.kind, key: finding.documentType, label: null, documents }
    case 'missing_plan':
      return { kind: finding.kind, key: finding.key, label: finding.label, documents }
    case 'incomplete_read':
      return null
  }
}

/** The references of the batch's documents the project cannot resolve, counted once each. */
function unresolvedReferenceCount(batch: readonly FindingsDocument[], project: readonly FindingsDocument[]): number {
  const missing = new Set<string>()
  for (const document of batch) {
    for (const resolved of resolveReferences(document, project)) {
      if (resolved.resolution === 'missing') missing.add(`${resolved.reference.kind}\u0000${resolved.reference.key}`)
    }
  }
  return missing.size
}

/**
 * What `batchDocuments` brought the project whose documents are
 * `projectDocuments` (the batch's own may be among them or not; a batch
 * document's row wins). With `profile`, the documents are compared with the
 * Steckbrief too, before and after alike.
 */
export function uploadReport(
  batchDocuments: readonly FindingsDocument[],
  projectDocuments: readonly FindingsDocument[],
  profile: ProfileFacts | null = null
): UploadReportSummary {
  const batchIds = new Set(batchDocuments.map((document) => document.id))
  const before = projectDocuments.filter((document) => !batchIds.has(document.id))
  const after = [...before, ...batchDocuments]
  const findingsBefore = deriveDocumentFindings(before, profile)
  const findingsAfter = deriveDocumentFindings(after, profile)
  const identitiesBefore = new Set(findingsBefore.map(findingIdentity))
  const identitiesAfter = new Set(findingsAfter.map(findingIdentity))
  const added = findingsAfter
    .filter((finding) => !identitiesBefore.has(findingIdentity(finding)))
    .map(reportFinding)
    .filter((finding): finding is UploadReportFinding => finding !== null)
  const resolved = findingsBefore.filter(
    (finding) => finding.kind !== 'incomplete_read' && !identitiesAfter.has(findingIdentity(finding))
  )
  const current = batchDocuments.filter((document) => !document.superseded)
  const partlyRead = current.filter((document) => (document.coverage?.notRead ?? 0) > 0)
  return {
    documents: batchDocuments.length,
    read: batchDocuments.filter((document) => document.dossier !== null || document.coverage !== null).length,
    byType: typeCounts(batchDocuments),
    facts: current.reduce((sum, document) => sum + (document.dossier?.facts.length ?? 0), 0),
    factSamples: factSamples(current),
    newFindings: added.length,
    findings: added.slice(0, UPLOAD_REPORT_LIMITS.findings),
    resolvedFindings: resolved.length,
    unresolvedReferences: unresolvedReferenceCount(current, after),
    pagesNotRead: partlyRead.reduce((sum, document) => sum + (document.coverage?.notRead ?? 0), 0),
    documentsNotFullyRead: partlyRead.length,
  }
}

/** Does the report say anything a person would want told? An upload nothing was read of has nothing to report. */
export function reportSaysSomething(report: UploadReportSummary): boolean {
  return report.read > 0
}
