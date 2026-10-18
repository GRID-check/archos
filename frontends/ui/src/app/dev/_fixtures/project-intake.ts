/**
 * Review fixtures for the setup page (`/dev/project-setup`) and its specs: a
 * project that waits for documents, one being read, one whose reading failed, one ready with
 * contradictions, Rückfragen, suggestions and derivations, a past project the
 * review will close, and a finished one. Values, labels and keys are the
 * wizard's own (`lib/project-profile/intake-definition.ts`); the project is an
 * Aufstockung in Wien, the example the create dialog names.
 */

import type { GeocodeResult } from '@/lib/geocoding/types'
import type { ListedProposal, ProposedChangeView } from '@/lib/proposals/types'
import type {
  DerivationReview,
  IntakeView,
  Need,
  ProfileEvidence,
  Suggestion,
  SuggestionGroup,
} from '@/lib/project-intake/types'

export const FIXTURE_PROJECT_ID = '00000000-0000-4000-8000-0000000000a1'

export const FIXTURE_LOCATION: GeocodeResult = {
  label: 'Lacknergasse 12, 1170 Wien',
  lat: 48.2306,
  lon: 16.3412,
  country: 'at',
  bundesland: 'wien',
  state: 'Wien',
  gemeinde: 'Wien',
  postcode: '1170',
  kind: 'address',
}

export const FIXTURE_DESCRIPTION =
  'Aufstockung eines Gründerzeithauses um zwei Geschoße, Dachgeschoßausbau mit 6 Wohnungen'

const AT = '2026-10-14T08:30:00.000Z'

export const fromDocument = (fileName: string, page: number | null, quote: string): ProfileEvidence => ({
  kind: 'document',
  fileName,
  page,
  quote,
})

const BAUBESCHREIBUNG = 'Baubeschreibung.pdf'
const SCHNITT = 'E-02 Schnitt A-A.pdf'

const suggestion = (
  key: string,
  label: string,
  value: Suggestion['value'],
  display: string,
  rest: Partial<Suggestion> = {}
): Suggestion => ({
  key,
  baseKey: key.split('@')[0],
  bauwerkId: key.includes('@') ? key.split('@')[1] : null,
  label,
  value,
  display,
  state: 'suggested',
  evidence: [],
  alternatives: [],
  decisive: false,
  ...rest,
})

export const SUGGESTION_ADDRESS = suggestion(
  'standort_adresse',
  'Adresse / Gemeinde',
  FIXTURE_LOCATION.label,
  FIXTURE_LOCATION.label,
  {
    state: 'confirmed',
    evidence: [{ kind: 'geocoder', provider: 'photon', label: FIXTURE_LOCATION.label, resolvedAt: AT }],
  }
)

/** Two documents state different storey counts: the contradiction, and a decisive one. */
export const SUGGESTION_STOREYS = suggestion(
  'geschosse_oberirdisch@bw1',
  'Anzahl oberirdischer Geschoße (Zielzustand)',
  6,
  '6',
  {
    state: 'contested',
    decisive: true,
    evidence: [
      fromDocument(BAUBESCHREIBUNG, 3, 'Das Gebäude erhält nach der Aufstockung insgesamt sechs oberirdische Geschoße.'),
    ],
    alternatives: [
      {
        value: 7,
        recordedAt: AT,
        evidence: [fromDocument(SCHNITT, 1, 'EG, 1.OG, 2.OG, 3.OG, 4.OG, 5.OG, DG (neu)')],
      },
    ],
  }
)

export const SUGGESTION_ESCAPE_LEVEL = suggestion('fluchtniveau_m@bw1', 'Fluchtniveau (Zielzustand)', 18.4, '18.4 m', {
  decisive: true,
  evidence: [fromDocument(SCHNITT, 1, 'Fluchtniveau +18,40 m über Gelände')],
})

export const SUGGESTION_TYPE = suggestion('bauwerkstyp@bw1', 'Art des Bauwerks', 'gebaeude', 'Gebäude', {
  evidence: [fromDocument(BAUBESCHREIBUNG, 1, 'Gegenstand des Verfahrens ist ein Wohngebäude in geschlossener Bauweise.')],
})

export const SUGGESTION_POSITION = suggestion('gebaeudestellung@bw1', 'Gebäudestellung', 'angebaut', 'angebaut', {
  evidence: [fromDocument(BAUBESCHREIBUNG, 2, 'Das Haus ist beidseitig an die Nachbargebäude angebaut.')],
})

export const SUGGESTION_UNITS = suggestion('nutzungseinheiten@bw1', 'Anzahl Nutzungseinheiten (Wohnungen + Betriebseinheiten, Zielzustand)', 14, '14', {
  decisive: true,
  evidence: [
    fromDocument(BAUBESCHREIBUNG, 4, 'Im Bestand befinden sich 8 Wohnungen, im Dachgeschoß entstehen 6 weitere.'),
    fromDocument('Wohnungsliste.xlsx', null, 'Top 1 bis Top 14'),
  ],
})

export const SUGGESTION_CLASS = suggestion('gebaeudeklasse@bw1', 'Gebäudeklasse', 5, 'GK 5', {
  decisive: true,
  evidence: [
    {
      kind: 'derivation',
      rule: 'gebaeudeklasse',
      citation: 'OIB-Richtlinien, Begriffsbestimmungen (Ausgabe 2023), „Gebäudeklassen“',
      inputs: [
        { key: 'geschosse_oberirdisch@bw1', value: 6, suggested: true },
        { key: 'fluchtniveau_m@bw1', value: 18.4, suggested: true },
      ],
    },
  ],
})

export const SUGGESTION_EDITION = suggestion('oib_ausgabe', 'OIB-Ausgabe', '2023', '2023', {
  evidence: [fromDocument('Bescheid.pdf', 1, 'nach den OIB-Richtlinien, Ausgabe 2023')],
})

export const SUGGESTION_PHASE = suggestion('projektphase', 'Aktuelle Projektphase', 'einreichplanung', 'Einreichplanung', {
  state: 'confirmed',
  evidence: [{ kind: 'person', userId: 'user_pl', at: AT }],
})

const GROUP_BASE: SuggestionGroup = {
  stage: 'A',
  title: 'Projektbasis',
  items: [SUGGESTION_ADDRESS, SUGGESTION_EDITION, SUGGESTION_PHASE],
}

const GROUP_BAUWERKE: SuggestionGroup = {
  stage: 'C',
  title: 'Bauwerke',
  items: [SUGGESTION_TYPE, SUGGESTION_STOREYS, SUGGESTION_ESCAPE_LEVEL, SUGGESTION_POSITION, SUGGESTION_UNITS],
}

export const QUESTION_AREA: Need = {
  key: 'bgf_oberirdisch@bw1',
  baseKey: 'bgf_oberirdisch',
  bauwerkId: 'bw1',
  label: 'Brutto-Grundfläche der oberirdischen Geschoße gesamt (Zielzustand)',
  type: 'number_tri',
  unit: 'm²',
  why: 'Die Fläche entscheidet bei Gebäuden mit bis zu vier Geschoßen mit, ob Gebäudeklasse 2 oder 3 gilt.',
  foundIn: ['Einreichplan (Plankopf)', 'Baubeschreibung'],
  decisive: true,
  state: 'open',
}

export const QUESTION_POSITION: Need = {
  key: 'einheiten_ueber_400@bw1',
  baseKey: 'einheiten_ueber_400',
  bauwerkId: 'bw1',
  label: 'Hat eine der Nutzungseinheiten mehr als 400 m² Brutto-Grundfläche?',
  type: 'yes_no_open',
  why: 'Eine große Einheit hebt ein Gebäude mit wenigen Einheiten in die höhere Gebäudeklasse.',
  foundIn: ['Einreichplan (Grundriss)', 'Baubeschreibung'],
  decisive: true,
  state: 'open',
}

export const QUESTION_USE: Need = {
  key: 'gebaeudestellung@bw1',
  baseKey: 'gebaeudestellung',
  bauwerkId: 'bw1',
  label: 'Gebäudestellung',
  type: 'single_select',
  options: [
    { token: 'freistehend', label: 'freistehend' },
    { token: 'angebaut', label: 'angebaut' },
    { token: 'reihenhaus', label: 'Reihenhaus' },
  ],
  why: 'Die Stellung zu den Nachbargebäuden trennt die Gebäudeklassen 1 und 2.',
  foundIn: ['Einreichplan (Lageplan)'],
  decisive: true,
  state: 'open',
}

/** The derived class is decided here, not among the review's modules. */
export const DERIVATION_READY: DerivationReview = {
  bauwerkId: 'bw1',
  rule: 'gebaeudeklasse',
  citation: 'OIB-Richtlinien, Begriffsbestimmungen (Ausgabe 2023), „Gebäudeklassen“',
  value: 5,
  hochhaus: false,
  inputs: [
    { key: 'bauwerkstyp@bw1', value: 'gebaeude', suggested: true },
    { key: 'geschosse_oberirdisch@bw1', value: 6, suggested: true },
    { key: 'fluchtniveau_m@bw1', value: 18.4, suggested: true },
    { key: 'nutzungseinheiten@bw1', value: 14, suggested: true },
    { key: 'gebaeudestellung@bw1', value: 'angebaut', suggested: false },
  ],
  missing: [],
  suggestion: SUGGESTION_CLASS,
}

export const DERIVATION_OPEN: DerivationReview = {
  bauwerkId: 'bw2',
  rule: 'gebaeudeklasse',
  citation: 'OIB-Richtlinien, Begriffsbestimmungen (Ausgabe 2023), „Gebäudeklassen“',
  value: null,
  hochhaus: false,
  inputs: [{ key: 'bauwerkstyp@bw2', value: 'gebaeude', suggested: false }],
  missing: ['geschosse_oberirdisch', 'fluchtniveau_m', 'bgf_oberirdisch'],
  suggestion: null,
}

const BASE: IntakeView = {
  projectId: FIXTURE_PROJECT_ID,
  status: 'waiting',
  mode: 'active',
  description: FIXTURE_DESCRIPTION,
  location: FIXTURE_LOCATION,
  closing: null,
  counts: { documentsRead: 0, unreadDocuments: 0, suggested: 0, contradictions: 0, decisiveOpen: 0 },
  readingStartedAt: null,
  readingFinishedAt: null,
  summary: null,
  contradictions: [],
  questions: [],
  groups: [],
  derivations: [],
  canDecide: true,
  canComplete: true,
}

/** Created a moment ago: the address is on the profile, no documents yet. */
export const INTAKE_WAITING: IntakeView = { ...BASE, groups: [{ ...GROUP_BASE, items: [SUGGESTION_ADDRESS] }] }

/** A reading in its first minutes: some documents read, the first values found. */
export const INTAKE_READING: IntakeView = {
  ...BASE,
  status: 'reading',
  counts: { documentsRead: 9, unreadDocuments: 14, suggested: 6, contradictions: 0, decisiveOpen: 0 },
  readingStartedAt: '2026-10-14T08:31:00.000Z',
  groups: [
    { ...GROUP_BASE, items: [SUGGESTION_ADDRESS, SUGGESTION_EDITION] },
    { ...GROUP_BAUWERKE, items: [SUGGESTION_TYPE, SUGGESTION_POSITION] },
  ],
}

/** The reading stopped part-way: what was found stays, the rest is unread, and another reading is the way on. */
export const INTAKE_FAILED: IntakeView = {
  ...INTAKE_READING,
  status: 'failed',
  readingFinishedAt: '2026-10-14T08:36:00.000Z',
}

/** The review: a contradiction, Rückfragen, suggestions by module, and two derivations. */
export const INTAKE_READY: IntakeView = {
  ...BASE,
  status: 'ready',
  counts: { documentsRead: 23, unreadDocuments: 0, suggested: 41, contradictions: 1, decisiveOpen: 3 },
  readingStartedAt: '2026-10-14T08:31:00.000Z',
  readingFinishedAt: '2026-10-14T08:44:00.000Z',
  summary:
    '23 Dokumente gelesen. Die Geschoßanzahl ist widersprüchlich (Baubeschreibung: 6, Schnitt: 7); Fläche und Einheiten über 400 m² stehen in keinem Dokument.',
  contradictions: [SUGGESTION_STOREYS],
  questions: [QUESTION_AREA, QUESTION_POSITION, QUESTION_USE],
  groups: [GROUP_BASE, GROUP_BAUWERKE],
  derivations: [DERIVATION_READY, DERIVATION_OPEN],
}

/** A past project read for the office's reference: nothing is decisive, finishing closes it. */
export const INTAKE_CLOSING: IntakeView = {
  ...INTAKE_READY,
  mode: 'closing',
  closing: { outcome: 'completed', startedOn: '2019-03', endedOn: '2022-08' },
  counts: { documentsRead: 31, unreadDocuments: 0, suggested: 52, contradictions: 0, decisiveOpen: 0 },
  summary: null,
  contradictions: [],
  questions: [],
  groups: [GROUP_BASE, { ...GROUP_BAUWERKE, items: GROUP_BAUWERKE.items.map((item) => ({ ...item, decisive: false })) }],
  derivations: [DERIVATION_READY],
}

/** Finished: every value is confirmed. */
export const INTAKE_COMPLETED: IntakeView = {
  ...INTAKE_READY,
  status: 'completed',
  counts: { documentsRead: 23, unreadDocuments: 0, suggested: 0, contradictions: 0, decisiveOpen: 0 },
  contradictions: [],
  questions: [],
  summary: null,
  groups: [GROUP_BASE, GROUP_BAUWERKE].map((group) => ({
    ...group,
    items: group.items.map((item) => ({ ...item, state: 'confirmed' as const, alternatives: [] })),
  })),
  derivations: [{ ...DERIVATION_READY, suggestion: { ...SUGGESTION_CLASS, state: 'confirmed', alternatives: [] } }],
  canDecide: false,
  canComplete: false,
}

export const INTAKE_FIXTURES = {
  waiting: INTAKE_WAITING,
  reading: INTAKE_READING,
  failed: INTAKE_FAILED,
  ready: INTAKE_READY,
  closing: INTAKE_CLOSING,
  completed: INTAKE_COMPLETED,
} as const

export type IntakeFixtureName = keyof typeof INTAKE_FIXTURES

type FilingProposal = Extract<ProposedChangeView, { kind: 'file_operation' }>

const filingProposal = (id: string, patch: Pick<FilingProposal, 'payload'>): FilingProposal => ({
  id,
  projectId: FIXTURE_PROJECT_ID,
  status: 'proposed',
  proposedByKind: 'piloti',
  onBehalfOf: 'user_me',
  onBehalfOfName: 'Mia Huber',
  originConversationId: null,
  originMessageId: null,
  createdAt: AT,
  decidedBy: null,
  decidedByName: null,
  decidedAt: null,
  results: null,
  canDecide: true,
  kind: 'file_operation',
  ...patch,
})

/**
 * Piloti's two open filing suggestions for the project, one per target folder:
 * two files into a folder that exists, and one into a folder it would create.
 * What `GET /api/proposals?projectId=…&kind=file_operation` answers, so the
 * setup page's „Ablage“ section and its specs read the real shape.
 */
export const INTAKE_FILING: ListedProposal[] = [
  {
    proposal: filingProposal('00000000-0000-4000-8000-0000000000b1', {
      payload: {
        operation: 'move',
        operations: [
          {
            document: 'Bescheid_MA37_Aufstockung.pdf',
            source: 'projekt',
            target_folder: 'Behörde/Bescheide',
            reason: 'Ein Bescheid der MA 37; „Bescheide“ hält laut Beschreibung Bescheide und Stellungnahmen.',
          },
          {
            document: 'Stellungnahme_MA19_Ortsbild.pdf',
            source: 'projekt',
            target_folder: 'Behörde/Bescheide',
            reason: 'Eine Stellungnahme der MA 19 zum Ortsbild.',
          },
        ],
        basis: 'name',
      },
    }),
    documents: [
      { id: 'doc-bescheid', name: 'Bescheid_MA37_Aufstockung.pdf' },
      { id: 'doc-ortsbild', name: 'Stellungnahme_MA19_Ortsbild.pdf' },
    ],
  },
  {
    proposal: filingProposal('00000000-0000-4000-8000-0000000000b2', {
      payload: {
        operation: 'move',
        operations: [
          {
            document: 'Statik_Gutachten_Dachstuhl.pdf',
            source: 'projekt',
            target_folder: 'Gutachten',
            reason: 'Ein statisches Gutachten zum Dachstuhl; das Büro legt Gutachten in vier Projekten unter „Gutachten“ ab.',
          },
        ],
        basis: 'content',
        new_folder: { path: 'Gutachten', description: 'Statische, bauphysikalische und brandschutztechnische Gutachten' },
      },
    }),
    documents: [{ id: 'doc-statik', name: 'Statik_Gutachten_Dachstuhl.pdf' }],
  },
]

/** The states that have open filing suggestions: a project with documents read and not yet finished. */
export const INTAKE_FILING_STATES: readonly IntakeFixtureName[] = ['ready', 'closing']
