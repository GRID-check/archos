/**
 * Fixtures for `/dev/look` (ADR-0128): where the agent looked on an A1 Grundriss
 * (`a1-sheet.ts`, served by the page's fetch shim as a stored document's
 * `/file`), as the look card's items and as the turn's wire steps.
 *
 * The regions are shares of the sheet as shown, `[x, y, w, h]`, origin top
 * left: the title block (Plankopf) in the bottom right corner, the room Top 1
 * at the plan's lower left, and the hatched stair core in its middle.
 */

import type { AnswerCard } from '@/shared/cards/schemas'

/** The stored document the shim answers with the A1 sheet. */
export const LOOK_SHEET_ID = 'dev-look-sheet'
/** A document the reader may not open: the shim answers 404, as `getAccessibleDocument` does. */
export const LOOK_HIDDEN_ID = 'dev-look-hidden'
export const LOOK_SHEET_NAME = 'WBN_Grundriss_1OG_Index_C.pdf'

type LookCardData = Extract<AnswerCard, { type: 'look' }>

const PLANKOPF = [0.765, 0.852, 0.225, 0.135]
const TOP_1 = [0.084, 0.62, 0.13, 0.225]
const CORE = [0.415, 0.39, 0.105, 0.16]

/** Two looks and the box the agent showed the room. */
export const LOOK_CARD: LookCardData = {
  type: 'look',
  document: { id: LOOK_SHEET_ID, name: LOOK_SHEET_NAME, shelf: 'stored' },
  items: [
    {
      origin: 'look',
      page: 1,
      frame: 'page',
      scope: 'region',
      region: PLANKOPF,
      where: 'unten rechts',
      question: 'Planstand und Index im Plankopf?',
      reading: 'Index C, Maßstab 1:100',
      label: null,
      point: null,
      image_index: null,
      revision_id: null,
    },
    {
      origin: 'look',
      page: 1,
      frame: 'page',
      scope: 'region',
      region: TOP_1,
      where: 'links unten',
      question: 'Fläche Wohnen/Essen Top 1?',
      reading: '38,42 m²',
      label: null,
      point: null,
      image_index: null,
      revision_id: null,
    },
    {
      origin: 'reference',
      page: 1,
      frame: 'page',
      scope: 'region',
      region: CORE,
      where: 'in der Mitte',
      label: 'Treppenhaus-Kern',
      question: null,
      reading: null,
      point: null,
      image_index: null,
      revision_id: null,
    },
  ],
}

/** A look at a document the reader may not open: the place in words, no picture. */
export const LOOK_CARD_NO_ACCESS: LookCardData = {
  type: 'look',
  document: { id: LOOK_HIDDEN_ID, name: 'Brandschutzplan_EG.pdf', shelf: 'stored' },
  items: [
    {
      origin: 'look',
      page: 3,
      frame: 'page',
      scope: 'overview',
      region: null,
      where: null,
      question: 'Fluchtwege im Erdgeschoss?',
      reading: null,
      label: null,
      point: null,
      image_index: null,
      revision_id: null,
    },
  ],
}

const look = (n: number, region: number[] | null, where: string | null, question: string, reading: string) => ({
  type: 'STEP_FINISHED',
  step: {
    id: `look:${n}`,
    kind: 'look',
    round: 0,
    document_name: LOOK_SHEET_NAME,
    document_id: LOOK_SHEET_ID,
    shelf: 'stored',
    page: 1,
    region,
    where,
    question,
    reading,
  },
})

/** The turn's steps: one retrieval round that found the sheet, then two looks at it, then a third after a second round. */
export const LOOK_STEP_BODIES: Record<string, unknown>[] = [
  {
    type: 'STEP_FINISHED',
    step: {
      id: 'status:retrieval:0',
      kind: 'retrieval',
      round: 0,
      key: 'status.retrieval.withQuery',
      values: { corpus: 'knowledge', query: 'Grundriss 1. OG Plankopf' },
      tools: ['knowledge_search'],
      reason: 'Der Grundriss 1. OG ist das Blatt, auf dem Index und Flächen stehen.',
    },
  },
  {
    type: 'STEP_FINISHED',
    step: {
      id: 'sources:0:knowledge_search:1',
      kind: 'sources',
      round: 0,
      tool: 'knowledge_search',
      lanes: [
        {
          key: 'project',
          label: 'Projektdokumente',
          kind: 'project',
          hit_count: 1,
          sources: [{ name: LOOK_SHEET_NAME }],
        },
      ],
    },
  },
  look(1, null, null, 'Welches Blatt ist das?', 'Grundriss 1. Obergeschoss'),
  look(2, PLANKOPF, 'unten rechts', 'Planstand und Index im Plankopf?', 'Index C, Maßstab 1:100'),
  look(3, TOP_1, 'links unten', 'Fläche Wohnen/Essen Top 1?', '38,42 m²'),
]
