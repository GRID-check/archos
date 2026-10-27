/**
 * A search answer as `POST /api/search` gives it, for the `/dev/search`
 * preview and the organism's specs: Lena's Tuesday from
 * `docs/design/document-search.md`, two Wiener projects, the passage on S. 7,
 * the annotation on EP-03, yesterday's conversation about OIB-RL 2.
 */

import type { DocumentHit, SearchResponse } from '@/lib/search/search-wire'
import type { SavedSearchView } from '@/lib/search/saved-search-client'

const P_HOUSING = '0b6f0c1e-3a55-4c0e-9a1d-7f2b5d0e1a01'
const P_ROOF_CONVERSION = '0b6f0c1e-3a55-4c0e-9a1d-7f2b5d0e1a02'
const F_SUBMISSION = '5d1a2c3b-1111-4a2b-8c3d-000000000001'
const F_FIRE_SAFETY = '5d1a2c3b-1111-4a2b-8c3d-000000000002'

function doc(partial: Partial<DocumentHit> & Pick<DocumentHit, 'id' | 'name'>): DocumentHit {
  return {
    kind: 'document',
    filename: `${partial.name}.pdf`,
    shelf: 'project',
    projectId: P_HOUSING,
    projectName: 'Wohnhaus Seestadt Baufeld J7',
    folderId: F_SUBMISSION,
    folderName: 'Einreichung',
    status: 'success',
    contentType: 'application/pdf',
    uploadedAt: '2026-10-20T08:12:00.000Z',
    uploadedBy: 'user_lena',
    documentType: 'submission_drawing',
    title: null,
    planNumber: null,
    planIndex: null,
    planDate: null,
    scale: null,
    documentDate: null,
    pageCount: 1,
    pagesNotRead: 0,
    superseded: false,
    changedFacts: [],
    municipality: 'Wien',
    author: 'Atelier Lindner ZT GmbH',
    matchedOn: ['reading'],
    passage: null,
    ...partial,
  }
}

export const SEARCH_FIXTURE_DOCUMENTS: DocumentHit[] = [
  doc({
    id: 'd0000000-0000-4000-8000-000000000001',
    name: 'Brandschutzkonzept_GK4_Seestadt_J7',
    title: 'Brandschutzkonzept Wohnhaus Seestadt J7',
    folderId: F_FIRE_SAFETY,
    folderName: 'Brandschutz',
    documentType: 'fire_safety_concept',
    documentDate: '2026-09-30',
    pageCount: 24,
    matchedOn: ['content', 'reading'],
    passage: { text: 'Die Fluchtweglänge beträgt max. 40 m bis zum nächsten gesicherten Stiegenhaus (GK 4, OIB-RL 2, Pkt. 5.1.1)', page: 7 },
  }),
  doc({
    id: 'd0000000-0000-4000-8000-000000000002',
    name: 'EP-03_Grundriss_EG_IndexC',
    title: 'Grundriss Erdgeschoss',
    planNumber: 'EP-03',
    planIndex: 'C',
    planDate: '2026-10-14',
    scale: '1:100',
    changedFacts: [
      { key: 'escape_route_length', before: '38,50 m', after: '42,10 m', page: 1 },
      { key: 'storeys_above_ground', before: '4', after: '5', page: 1 },
    ],
    matchedOn: ['name', 'content'],
    passage: { text: 'Fluchtweg Stiege 2, Länge 42,10 m', page: 1 },
  }),
  doc({
    id: 'd0000000-0000-4000-8000-000000000003',
    name: 'EP-03_Grundriss_EG_IndexB',
    title: 'Grundriss Erdgeschoss',
    planNumber: 'EP-03',
    planIndex: 'B',
    planDate: '2026-08-02',
    scale: '1:100',
    superseded: true,
    uploadedAt: '2026-08-03T10:00:00.000Z',
  }),
  doc({
    id: 'd0000000-0000-4000-8000-000000000004',
    name: 'EP-05_Schnitt_A-A',
    title: 'Schnitt A–A',
    planNumber: 'EP-05',
    planIndex: 'A',
    planDate: '2026-10-14',
    scale: '1:100',
  }),
  doc({
    id: 'd0000000-0000-4000-8000-000000000005',
    name: 'Brandschutzgutachten_Hernalser_Hauptstrasse',
    title: 'Brandschutztechnisches Gutachten',
    projectId: P_ROOF_CONVERSION,
    projectName: 'Dachausbau Hernalser Hauptstraße 112',
    folderId: null,
    folderName: null,
    documentType: 'expert_report',
    pageCount: 31,
    pagesNotRead: 4,
    matchedOn: ['content'],
    passage: { text: 'Fluchtwege im Dachgeschoss: Fluchtweglänge 38 m, Gebäudeklasse 4 gemäß OIB-RL 2', page: 12 },
  }),
  doc({
    id: 'd0000000-0000-4000-8000-000000000006',
    name: 'OIB-RL2_2023_Brandschutz',
    title: 'OIB-Richtlinie 2: Brandschutz (Ausgabe Mai 2023)',
    shelf: 'office_shelf',
    projectId: null,
    projectName: null,
    folderId: null,
    folderName: 'Richtlinien',
    documentType: 'legal_text',
    pageCount: 38,
    matchedOn: ['content'],
    passage: { text: 'Die Fluchtweglänge darf 40 m nicht überschreiten', page: 9 },
  }),
]

export const SEARCH_FIXTURE_RESPONSE: SearchResponse = {
  scope: { kind: 'office' },
  sections: {
    document: { hits: SEARCH_FIXTURE_DOCUMENTS, total: 14, totalIsLowerBound: false, nextCursor: 'cursor-document-2' },
    annotation: {
      hits: [
        {
          kind: 'annotation',
          shelf: 'project',
          id: 'a0000000-0000-4000-8000-000000000001',
          documentId: 'd0000000-0000-4000-8000-000000000002',
          documentName: 'EP-03 Grundriss EG, Index C',
          projectId: P_HOUSING,
          projectName: 'Wohnhaus Seestadt Baufeld J7',
          annotationKind: 'defect',
          status: 'open',
          excerpt: 'Stiege 2 liegt 2 m zu weit weg: Fluchtweglänge 42 m statt max. 40 m. Bitte mit Tragwerksplanung abstimmen.',
          assigneeUserId: 'user_lena',
          createdAt: '2026-10-26T15:40:00.000Z',
        },
      ],
      total: 1,
      totalIsLowerBound: false,
      nextCursor: null,
    },
    folder: {
      hits: [
        {
          kind: 'folder',
          id: F_FIRE_SAFETY,
          name: 'Brandschutz',
          shelf: 'project',
          projectId: P_HOUSING,
          projectName: 'Wohnhaus Seestadt Baufeld J7',
          excerpt: 'Brandschutzkonzept, Fluchtwegpläne und Stellungnahmen der MA 37',
        },
      ],
      total: 1,
      totalIsLowerBound: false,
      nextCursor: null,
    },
    project: { hits: [], total: 0, totalIsLowerBound: false, nextCursor: null },
    conversation: {
      hits: [
        {
          kind: 'conversation',
          id: 'c0000000-0000-4000-8000-000000000001',
          title: 'Fluchtweglängen nach OIB-RL 2 für GK 4',
          projectId: P_HOUSING,
          projectName: 'Wohnhaus Seestadt Baufeld J7',
          updatedAt: '2026-10-26T16:05:00.000Z',
        },
      ],
      total: 1,
      totalIsLowerBound: false,
      nextCursor: null,
    },
  },
  facets: {
    documentType: [
      { value: 'submission_drawing', label: null, count: 9 },
      { value: 'fire_safety_concept', label: null, count: 2 },
      { value: 'expert_report', label: null, count: 2 },
      { value: 'legal_text', label: null, count: 1 },
    ],
    tag: [
      { value: 'Brandschutz', label: null, count: 6 },
      { value: 'Grundriss', label: null, count: 5 },
      { value: 'Schnitt', label: null, count: 2 },
    ],
    project: [
      { value: P_HOUSING, label: 'Wohnhaus Seestadt Baufeld J7', count: 12 },
      { value: P_ROOF_CONVERSION, label: 'Dachausbau Hernalser Hauptstraße 112', count: 1 },
    ],
    partyRole: [
      { value: 'architect', label: null, count: 11 },
      { value: 'client', label: null, count: 9 },
      { value: 'authority', label: null, count: 2 },
    ],
    municipality: [{ value: 'Wien', label: null, count: 13 }],
    cites: [
      { value: 'norm:OIB-RL 2', label: 'OIB-RL 2', count: 5 },
      { value: 'norm:ÖNORM B 1600', label: 'ÖNORM B 1600', count: 3 },
      { value: 'plan:EP-05', label: 'EP-05', count: 2 },
    ],
    state: [
      { value: 'readable', label: null, count: 13 },
      { value: 'reading', label: null, count: 1 },
    ],
    fileType: [
      { value: 'pdf', label: null, count: 13 },
      { value: 'dwg', label: null, count: 1 },
    ],
    changedFact: [
      { value: 'escape_route_length', label: null, count: 1 },
      { value: 'storeys_above_ground', label: null, count: 1 },
    ],
  },
  unread: 3,
  building: ['office_shelf'],
  contentPartial: false,
}

export const SEARCH_FIXTURE_SAVED: SavedSearchView[] = [
  {
    id: 's0000000-0000-4000-8000-000000000001',
    name: 'Einreichpläne, aktuell',
    scope: { scope: 'project', projectId: P_HOUSING },
    query: { kinds: ['document'], filters: { documentTypes: ['submission_drawing'], currentOnly: true }, sort: 'plan_number', dir: 'asc' },
    shared: true,
    ownedByMe: true,
    ownerName: null,
    createdAt: '2026-10-21T09:10:00.000Z',
  },
  {
    id: 's0000000-0000-4000-8000-000000000002',
    name: 'Zitiert ÖNORM B 1600',
    scope: {},
    query: { filters: { cites: ['ÖNORM B 1600'] } },
    shared: true,
    ownedByMe: false,
    ownerName: 'Max Gruber',
    createdAt: '2026-10-02T13:00:00.000Z',
  },
]

const drawing = (n: number, partial: Partial<DocumentHit> & Pick<DocumentHit, 'name'>): DocumentHit =>
  doc({ id: `d0000000-0000-4000-8000-0000000001${String(n).padStart(2, '0')}`, matchedOn: ['reading'], ...partial })

/**
 * The rest of the Seestadt Einreichung, for the register at 09:10: a
 * Planliste has more than three rows. Only the register preview reads these;
 * the list's answer stays Lena's 08:55 search.
 */
export const SEARCH_FIXTURE_REGISTER_DOCUMENTS: DocumentHit[] = [
  drawing(1, { name: 'EP-01_Lageplan', title: 'Lageplan', planNumber: 'EP-01', planIndex: 'A', planDate: '2026-09-12', scale: '1:500' }),
  drawing(2, { name: 'EP-02_Grundriss_KG', title: 'Grundriss Kellergeschoss', planNumber: 'EP-02', planIndex: 'B', planDate: '2026-10-01', scale: '1:100' }),
  drawing(3, { name: 'EP-04_Grundriss_1OG_IndexB', title: 'Grundriss 1. Obergeschoss', planNumber: 'EP-04', planIndex: 'B', planDate: '2026-10-14', scale: '1:100' }),
  drawing(4, {
    name: 'EP-04_Grundriss_1OG_IndexA',
    title: 'Grundriss 1. Obergeschoss',
    planNumber: 'EP-04',
    planIndex: 'A',
    planDate: '2026-08-02',
    scale: '1:100',
    superseded: true,
    uploadedAt: '2026-08-03T10:00:00.000Z',
  }),
  drawing(5, { name: 'EP-06_Ansichten_Nord_Sued', title: 'Ansichten Nord und Süd', planNumber: 'EP-06', planIndex: 'A', planDate: '2026-10-14', scale: '1:100' }),
  drawing(6, {
    name: 'TW-01_Positionsplan_Decke_EG',
    title: 'Positionsplan Decke über EG',
    planNumber: 'TW-01',
    planIndex: 'A',
    planDate: '2026-10-09',
    scale: '1:50',
    author: 'Haas Tragwerksplanung ZT GmbH',
    pageCount: 2,
  }),
  drawing(7, { name: 'Einreichung_Deckblatt', title: 'Deckblatt Einreichung', planDate: '2026-10-14' }),
]
