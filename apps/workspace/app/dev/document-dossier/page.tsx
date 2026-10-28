'use client'

/**
 * Dev preview for the document dossier (`docs/architecture/document-dossier.md`):
 * the „Piloti reading“ rail of a Baubeschreibung with its type, parties, dates,
 * place, facts, references (resolved, missing, norms and laws), „Verwiesen
 * von“ and the coverage line; beside it, a drawing's rail; and above both the
 * project's „Befunde aus den Dokumenten“ panel, compared with a Steckbrief
 * that holds GK 3 and Holzbau (`profile_contradiction`). Below them, the
 * Eingangsbericht the inbox row shows for an upload that brought the drawing
 * and the Brandschutzkonzept. The findings, the resolved references and the
 * report are computed by the real pure functions (`lib/documents/findings.ts`,
 * `lib/upload-batches/upload-report.ts`) over the fixtures, so the preview
 * shows what the route and the settle would serve.
 *
 * Pinned to German, the copy under review. Links point at a project that does
 * not exist; they are there to be seen, not followed.
 */

import type { JSX } from 'react'
import { I18nProvider } from '@/i18n'
import { InspectorGroup } from '@/components/ui/inspector-group'
import { AgentReading } from '@/features/documents/components/agent-reading'
import { DocumentFindingsList } from '@/features/documents/components/document-findings-panel'
import type { FileItem } from '@/features/documents/file-types'
import { deriveDocumentFindings, referencedBy, resolveReferences, toFindingsDocument } from '@/lib/documents/findings'
import type { DocumentFindingsResponse, DocumentLinks } from '@/lib/documents/findings-wire'
import type { ProfileFacts } from '@/lib/documents/profile-contradictions'
import { UploadReportLines } from '@/features/uploads/components/upload-report'
import { uploadReport, type UploadReport } from '@/lib/upload-batches/upload-report'

const PROJECT_ID = 'proj-hubergasse'

function makeFile(id: string, filename: string, extra: Partial<FileItem> = {}): FileItem {
  return {
    id,
    filename,
    displayName: null,
    fileSize: 2_400_000,
    contentType: 'application/pdf',
    status: 'completed',
    folderId: null,
    createdAt: '2026-09-02T09:00:00Z',
    errorMessage: null,
    summary: null,
    pageCount: 12,
    chunkCount: 40,
    contentTypes: ['text', 'table'],
    tags: null,
    topics: null,
    capture: null,
    assignees: [],
    authoredBy: 'user',
    ...extra,
  }
}

const DESCRIPTION = makeFile('doc-description', 'Baubeschreibung_Hubergasse14_Einreichung.pdf', {
  summary: 'Baubeschreibung zur Einreichung eines viergeschossigen Wohnhauses mit 12 Wohneinheiten in der Hubergasse 14.',
  tags: ['Sonstiges'],
  pageCount: 18,
  dossier: {
    documentType: 'building_description',
    title: 'Baubeschreibung Wohnhaus Hubergasse 14',
    summary: null,
    parties: [
      { role: 'client', name: 'Hubergasse 14 Projektentwicklung GmbH' },
      { role: 'architect', name: 'Atelier Lindner Architektur ZT GmbH' },
    ],
    dates: [{ kind: 'issued', date: '2025-03-14' }],
    place: { address: 'Hubergasse 14', municipality: 'Wien', state: 'Wien' },
    facts: [
      { key: 'building_class', value: 'GK 4', unit: null, page: 2, quote: 'Das Gebäude ist der Gebäudeklasse 4 zuzuordnen.' },
      { key: 'storeys_above_ground', value: '4', unit: null, page: 2, quote: '4 oberirdische Geschosse' },
      { key: 'gross_floor_area', value: '1.245,5', unit: 'm²', page: 3, quote: 'BGF gesamt 1.245,5 m²' },
      { key: 'units', value: '12', unit: null, page: 3, quote: '12 Wohneinheiten' },
      { key: 'heating_demand', value: '28,4', unit: 'kWh/m²a', page: 9, quote: 'HWB 28,4 kWh/m²a' },
    ],
  },
  docReferences: [
    { kind: 'document', key: 'fire_safety_concept', label: 'Brandschutzkonzept', pages: [6] },
    { kind: 'document', key: 'soil_report', label: 'Bodengutachten', pages: [7] },
    { kind: 'plan', key: 'ep-05', label: 'EP-05', pages: [1, 4] },
    { kind: 'plan', key: 'ep-07', label: 'EP-07', pages: [4] },
    { kind: 'norm', key: 'önorm b 1600', label: 'ÖNORM B 1600', pages: [3, 7] },
    { kind: 'norm', key: 'oib-rl 2', label: 'OIB-RL 2', pages: [6] },
    { kind: 'law', key: '§ 81 bo für wien', label: '§ 81 BO für Wien', pages: [2] },
  ],
  coverage: { pages: 18, text: 18, transcribed: 0, drawings: 0, drawingsRead: 0, notRead: 0, reasons: {} },
})

const GROUND_FLOOR = makeFile('doc-ep05', 'EP05_Grundriss_EG_Index-C.pdf', {
  displayName: 'Grundriss EG',
  tags: ['Grundriss'],
  pageCount: 40,
  contentTypes: ['text', 'drawing'],
  revisionFacts: { documentNumber: 'EP-05', revision: 'C', revisionDate: '2025-03-12', scale: '1:100' },
  dossier: {
    documentType: 'submission_drawing',
    title: 'Grundriss Erdgeschoss',
    summary: null,
    parties: [{ role: 'architect', name: 'Atelier Lindner Architektur ZT GmbH' }],
    dates: [{ kind: 'plan_date', date: '2025-03-12' }],
    place: null,
    facts: [{ key: 'storeys_above_ground', value: '5', unit: null, page: 1, quote: '5 oberirdische Geschosse' }],
  },
  coverage: { pages: 40, text: 30, transcribed: 5, drawings: 5, drawingsRead: 3, notRead: 2, reasons: { render_cap: 2 } },
})

const FIRE_CONCEPT = makeFile('doc-fire', 'Brandschutzkonzept_V2.pdf', {
  tags: ['Gutachten', 'Brandschutz'],
  dossier: {
    documentType: 'fire_safety_concept',
    title: 'Brandschutzkonzept Hubergasse 14',
    summary: null,
    parties: [],
    dates: [],
    place: { state: 'Wien' },
    facts: [
      { key: 'building_class', value: 'GK 4', unit: null, page: 2, quote: 'Gebäudeklasse 4 gem. OIB-RL 2' },
      { key: 'construction_method', value: 'Stahlbeton', unit: null, page: 3, quote: 'Tragwerk in Stahlbeton' },
    ],
  },
  docReferences: [{ kind: 'document', key: 'building_description', label: 'Baubeschreibung', pages: [2] }],
})

const FILES = [DESCRIPTION, GROUND_FLOOR, FIRE_CONCEPT]

const DOCUMENTS = FILES.map(toFindingsDocument)

/** The Steckbrief: confirmed GK 3, Holzbau, Wien. */
const PROFILE: ProfileFacts = {
  facts: {
    building_class: { value: 'GK3' },
    construction_method: { value: ['timber'] },
    federal_state: { value: 'vienna' },
    storeys_above_ground: { value: 4 },
  },
}

const RESPONSE: DocumentFindingsResponse = {
  findings: deriveDocumentFindings(DOCUMENTS, PROFILE),
  documentCount: DOCUMENTS.length,
  truncated: false,
  document: null,
}

/** The upload that brought the drawing and the Brandschutzkonzept, onto a project that held the Baubeschreibung. */
const REPORT: UploadReport = {
  projectId: PROJECT_ID,
  ...uploadReport([GROUND_FLOOR, FIRE_CONCEPT].map(toFindingsDocument), DOCUMENTS, PROFILE),
}

const linksOf = (file: FileItem): DocumentLinks => {
  const subject = toFindingsDocument(file)
  return { references: resolveReferences(subject, DOCUMENTS), referencedBy: referencedBy(subject, DOCUMENTS) }
}

function Rail({ file, title }: { file: FileItem; title: string }): JSX.Element {
  return (
    <div className="flex w-[360px] flex-col gap-2">
      <p className="text-muted-foreground px-1 text-xs">{title}</p>
      <InspectorGroup className="p-3">
        <AgentReading file={file} canManage projectId={PROJECT_ID} dossierLinks={linksOf(file)} />
      </InspectorGroup>
    </div>
  )
}

export default function DocumentDossierDevPage(): JSX.Element {
  return (
    <I18nProvider initialLocale="de" fixedLocale>
      <main className="bg-muted/40 min-h-screen p-6" data-testid="dev-document-dossier">
        <div className="flex max-w-[780px] flex-col gap-6">
          <DocumentFindingsList projectId={PROJECT_ID} response={RESPONSE} />
          <div className="flex max-w-[520px] flex-col gap-2" data-testid="dev-upload-report">
            <p className="text-muted-foreground px-1 text-xs">Eingangsbericht (inbox row „Ihr Upload ist gelesen“)</p>
            <InspectorGroup className="p-3">
              <UploadReportLines report={REPORT} />
            </InspectorGroup>
          </div>
          <div className="flex flex-wrap items-start gap-6">
            <Rail file={DESCRIPTION} title={DESCRIPTION.filename} />
            <Rail file={GROUND_FLOOR} title={GROUND_FLOOR.filename} />
          </div>
        </div>
      </main>
    </I18nProvider>
  )
}
