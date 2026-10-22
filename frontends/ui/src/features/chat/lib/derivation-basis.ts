/**
 * What the Herleitung says about a turn as a whole, read off its stored steps
 * and its citation model: the header's counts and its one warning, the last
 * card („Grundlagen · Entwurf“), and the two shapes that need no graph (a turn
 * without research, a turn of one call).
 *
 * Pure, and every word a dictionary key. Two rules hold here:
 *  - Piloti never says „nachgewiesen“: the last card lists what the answer
 *    rests on and calls itself a draft (`Entwurf`).
 *  - A gap is stated as the gap: a search that found nothing says where it
 *    looked and for what, never „Keine Informationen gefunden“.
 */

import type { Translator } from '@/i18n'
import type { StoredThinkingStep } from '@/lib/conversations/message-provenance'
import {
  citationNumbers,
  citedLoci,
  isCited,
  type CitationLocus,
  type CitedDocument,
} from './citations'
import { documentEdition, documentShortName } from './document-names'
import { retrievalRounds } from './retrieval-rounds'
import {
  allRows,
  prefetchRounds,
  withActionRounds,
  workRounds,
  type WorkRound,
  type WorkRow,
} from './work-list'
import { breadcrumb, workParts } from './work-sentence'

const SHELF_KEYS: Record<string, string> = {
  project: 'project',
  office: 'office',
  office_shelf: 'office',
  base: 'base',
  web: 'web',
  session: 'session',
}

/** „Pkt. 3.1.1“ or „S. 7“: the address of one passage. */
export const locusLabel = (t: Translator, locus: CitationLocus): string | undefined => {
  const clause = locus.clause?.trim()
  if (clause) return /^pkt/i.test(clause) ? clause : t('thinking.node.basis.clause', { clause })
  return typeof locus.page === 'number'
    ? t('thinking.node.basis.page', { page: locus.page })
    : undefined
}

/**
 * Where in the document the answer stands: the cited passages, else the
 * passages read, at most two, deduplicated. A count of hits is no place.
 */
export const documentLocation = (t: Translator, doc: CitedDocument): string | undefined => {
  const loci = isCited(doc) ? citedLoci(doc) : doc.loci
  const labels = [...new Set(loci.flatMap((locus) => locusLabel(t, locus) ?? []))]
  return labels.length > 0 ? labels.slice(0, 2).join(', ') : undefined
}

/**
 * One line of „Grundlagen“: the `[N]` the answer cites the document by, and
 * „OIB-Richtlinie 2, Ausgabe Mai 2023, Pkt. 3.1.1“. The numbers stay numbers so
 * the card draws the answer's own marker for them rather than their text.
 */
export interface BasisLine {
  numbers: number[]
  text: string
}

const basisLine = (t: Translator, doc: CitedDocument): BasisLine => {
  const name = doc.fileName ?? doc.title
  const text = [
    documentShortName(name, doc.title),
    documentEdition(name, doc.title),
    documentLocation(t, doc),
  ]
    .filter(Boolean)
    .join(', ')
  return { numbers: citationNumbers(doc), text }
}

export interface BasisLines {
  /** The cited normative sources, with their edition: „Rechtsgrundlage“. */
  law: BasisLine[]
  /** The cited project, office and web sources, with their place: „Belegt durch“. */
  evidence: BasisLine[]
}

/** The cited documents of the turn, by their first `[N]`, split into the law and the rest. */
export function basisLines(t: Translator, cards: readonly CitedDocument[]): BasisLines {
  const cited = cards
    .filter(isCited)
    .sort((a, b) => (citationNumbers(a)[0] ?? Infinity) - (citationNumbers(b)[0] ?? Infinity))
  return {
    law: cited.filter((doc) => doc.kind === 'building_law').map((doc) => basisLine(t, doc)),
    evidence: cited.filter((doc) => doc.kind !== 'building_law').map((doc) => basisLine(t, doc)),
  }
}

/** One open point from a call that failed or found nothing; null for any other row. */
const openPoint = (t: Translator, row: WorkRow): string | null => {
  if (row.running || (row.action.status !== 'error' && row.action.status !== 'empty')) return null
  const parts = workParts(t, row.action)
  const what = [parts.verb, parts.object].filter(Boolean).join(' ')
  if (row.action.status === 'error') return t('thinking.node.basis.openFailed', { what })
  const { query, target } = row.action
  if (!query) return t('thinking.node.basis.openEmpty', { what })
  if (target) return t('thinking.node.basis.openNoHitIn', { target: breadcrumb(target), query })
  const shelfKey = row.action.shelf ? SHELF_KEYS[row.action.shelf.toLowerCase()] : undefined
  return shelfKey
    ? t('thinking.node.basis.openNoHitShelf', {
        shelf: t(`thinking.work.shelf.${shelfKey}`),
        query,
      })
    : t('thinking.node.basis.openNoHit', { query })
}

/** The open points of the turn: one per failed or empty call, failed first. */
export function openPoints(t: Translator, rounds: readonly WorkRound[]): string[] {
  const rows = rounds.flatMap(allRows)
  const ordered = [
    ...rows.filter((row) => row.action.status === 'error'),
    ...rows.filter((row) => row.action.status === 'empty'),
  ]
  return [...new Set(ordered.flatMap((row) => openPoint(t, row) ?? []))]
}

export interface DerivationOverview {
  /** The rounds a reader sees as „Schritt N“; the prefetch is none of them. */
  steps: number
  /** Documents the answer cites. */
  cited: number
  /** Calls that failed. */
  failed: number
  /** Calls that found nothing: an open point each. */
  open: number
  /** Whether the turn looked anything up, or ran any tool: only a turn that did neither is „ohne Recherche“. */
  researched: boolean
  /** The turn's one call, when it made exactly one and it settled with a result: the header is then the Herleitung. */
  single: WorkRow | null
}

/** The turn at a glance, for the header and its edge cases. */
export function derivationOverview(
  steps: readonly StoredThinkingStep[],
  cards: readonly CitedDocument[]
): DerivationOverview {
  const work = workRounds(steps)
  const prefetch = prefetchRounds(steps)
  const rounds = withActionRounds(retrievalRounds(steps), steps).filter(
    (round) => !prefetch.has(round.index)
  )
  const rows = work.flatMap(allRows)
  const settled = rows.filter((row) => !row.running)
  const only = rows.length === 1 && !rows[0].fold ? rows[0] : null
  return {
    steps: rounds.length,
    cited: cards.filter(isCited).length,
    failed: settled.filter((row) => row.action.status === 'error').length,
    open: settled.filter((row) => row.action.status === 'empty').length,
    researched:
      cards.length > 0 ||
      rounds.length > 0 ||
      prefetch.size > 0 ||
      steps.some((step) => step.kind === 'look' || step.kind === 'sources' || step.kind === 'tool'),
    single:
      only &&
      !only.running &&
      only.action.status === 'ok' &&
      rounds.length === 1 &&
      cards.length <= 1
        ? only
        : null,
  }
}
