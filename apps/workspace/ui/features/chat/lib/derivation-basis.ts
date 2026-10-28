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
import type { StoredAction, StoredThinkingStep } from '@/lib/conversations/message-provenance'
import {
  citationNumbers,
  citedLoci,
  isCited,
  oibDocumentKey,
  type CitationLocus,
  type CitedDocument,
} from './citations'
import { documentEdition, documentShortName } from './document-names'
import { retrievalRounds } from './retrieval-rounds'
import {
  allRows,
  isInterrupted,
  prefetchRounds,
  withActionRounds,
  workRounds,
  type WorkRound,
  type WorkRow,
} from './work-list'
import {
  actionPlace,
  breadcrumb,
  namePattern,
  placeIn,
  placeLabel,
  quoteQuery,
  sentenceKind,
  workParts,
} from './work-sentence'

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

/**
 * A document as its card names it: the short name and, when the title states
 * one, its edition („OIB-Richtlinie 2, Ausgabe Mai 2023“). The one naming the
 * card, the basis and the open points share, so a document never has two.
 */
export const cardName = (doc: CitedDocument): string => {
  const name = doc.fileName ?? doc.title
  return [documentShortName(name, doc.title), documentEdition(name, doc.title)]
    .filter(Boolean)
    .join(', ')
}

const basisLine = (t: Translator, doc: CitedDocument): BasisLine => {
  const text = [cardName(doc), documentLocation(t, doc)].filter(Boolean).join(', ')
  return { numbers: citationNumbers(doc), text }
}

const sameName = (a: string, b: string): boolean => a.trim().toLowerCase() === b.trim().toLowerCase()

/**
 * Two editions that may be the same one: either is unstated, or every number
 * the call's states („2023“) is in the card's („Mai 2023“). A Richtlinie of
 * another year is another document, and is never renamed to the card's.
 */
const editionsAgree = (stated: string | undefined, card: string | undefined): boolean => {
  if (!stated || !card) return true
  const numbers: readonly string[] = card.match(/\d+/g) ?? []
  return (stated.match(/\d+/g) ?? []).every((n) => numbers.includes(n))
}

/**
 * The card for the document a call named, when the turn has one: by its file
 * name or title, else by the short name both come to, else, for an OIB
 * Richtlinie, by its identity („OIB-RL 2, Ausgabe 2023“ is the card
 * „OIB-Richtlinie 2“; `oibDocumentKey` ignores the edition as the citation
 * model does). The call's `target` is the path the backend wrote
 * („Projekt/Brandschutzkonzept.pdf“), so the match is on its last part.
 */
export const cardForTarget = (
  target: string,
  cards: readonly CitedDocument[]
): CitedDocument | undefined => {
  const leaf = target.split(/[\\/›]+/).at(-1)?.trim() ?? ''
  if (!leaf) return undefined
  const short = documentShortName(leaf)
  const oib = oibDocumentKey(leaf)
  return (
    cards.find((doc) => [doc.fileName, doc.title].some((name) => name && sameName(name, leaf))) ??
    cards.find((doc) => sameName(documentShortName(doc.fileName ?? doc.title, doc.title), short)) ??
    (oib
      ? cards.find(
          (doc) =>
            (oibDocumentKey(doc.fileName) === oib || oibDocumentKey(doc.title) === oib) &&
            editionsAgree(
              documentEdition(leaf),
              documentEdition(doc.fileName ?? doc.title, doc.title)
            )
        )
      : undefined)
  )
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

/** Verbs whose call is known by the document or folder it opened, not by a query. */
const TARGET_VERBS: ReadonlySet<string> = new Set(['list', 'read', 'look'])

/**
 * A call as the subject of „… fehlgeschlagen ist“: „die Abfrage im RIS nach
 * ‚Brandabschnitt‘“, „das Lesen des Dokuments „Brandschutzkonzept““. A noun,
 * never the row's verb, so the sentence reads as one.
 */
const callNoun = (t: Translator, action: StoredAction): string => {
  const place = actionPlace(action)
  if (place) {
    // A call over the filesystem is named by where it looked: „die wörtliche Suche in allen Ablagen nach ‚…‘“.
    const kind = sentenceKind(action)
    const where = placeIn(t, place)
    // A pattern is no wörtliche Suche: „die Suche in der Büroablage › Vorlagen nach dem Muster ‚EI\s?90‘“.
    if (kind === 'grep' && action.mode === 'regex' && action.query)
      return t('thinking.node.basis.callPlacePattern', {
        place: where,
        query: quoteQuery(t, action.query),
      })
    const call = t(`thinking.node.basis.call.${kind}`)
    return action.query
      ? t('thinking.node.basis.callPlaceQuery', {
          call,
          place: where,
          query: quoteQuery(t, action.query),
        })
      : t('thinking.node.basis.callPlace', { call, place: where })
  }
  const call = t(`thinking.node.basis.call.${action.verb}`)
  if (TARGET_VERBS.has(action.verb) && action.target)
    return t('thinking.node.basis.callTarget', { call, target: breadcrumb(action.target) })
  if (action.query)
    return t('thinking.node.basis.callQuery', { call, query: quoteQuery(t, action.query) })
  return call
}

/**
 * One open point from a call that failed, broke off or found nothing; null for
 * any other row. A document the call named is named as its card names it
 * (`cardName`), so „Offen“ and the fan never call one document two things.
 */
const openPoint = (
  t: Translator,
  row: WorkRow,
  cards: readonly CitedDocument[]
): string | null => {
  const interrupted = isInterrupted(row)
  if (row.running || (!interrupted && row.action.status !== 'error' && row.action.status !== 'empty'))
    return null
  const card = row.action.target ? cardForTarget(row.action.target, cards) : undefined
  const action = card ? { ...row.action, target: cardName(card) } : row.action
  if (action.status === 'error') return t('thinking.node.basis.openFailed', { call: callNoun(t, action) })
  if (interrupted) return t('thinking.node.basis.openInterrupted', { call: callNoun(t, action) })
  // Most of the scope was searched and the rest could not be: not a no, and „Offen“ says which.
  if (action.incomplete)
    return t('thinking.node.basis.openIncomplete', { call: callNoun(t, action) })
  const missing = missingName(t, action)
  if (missing)
    return t(
      action.verb === 'read'
        ? 'thinking.node.basis.openNotFoundDocument'
        : 'thinking.node.basis.openNotFoundFolder',
      { name: missing }
    )
  const place = actionPlace(action)
  const kind = sentenceKind(action)
  if (place && action.query && kind === 'grep')
    return t('thinking.node.basis.openNoHitPlace', { call: callNoun(t, action) })
  if (place && action.query && kind === 'glob')
    return t('thinking.node.basis.openNoFile', {
      place: placeIn(t, place),
      what: namePattern(t, action.query),
    })
  const { query, target } = action
  if (!query) {
    const parts = workParts(t, action)
    return t('thinking.node.basis.openEmpty', {
      what: [parts.verb, parts.object].filter(Boolean).join(' '),
    })
  }
  const quoted = quoteQuery(t, query)
  if (target)
    return t('thinking.node.basis.openNoHitIn', {
      target: card ? target : breadcrumb(target),
      query: quoted,
    })
  const shelfKey = row.action.shelf ? SHELF_KEYS[row.action.shelf.toLowerCase()] : undefined
  return shelfKey
    ? t('thinking.node.basis.openNoHitShelf', {
        shelf: t(`thinking.work.shelf.${shelfKey}`),
        query: quoted,
      })
    : t('thinking.node.basis.openNoHit', { query: quoted })
}

/** The folder or document an empty listing or read did not find, by the name the row gives it; null otherwise. */
const missingName = (t: Translator, action: StoredAction): string | null => {
  if (!action.missing) return null
  if (action.verb === 'read') return action.target || null
  const place = actionPlace(action)
  return place ? placeLabel(t, place) : null
}

/**
 * The open points of the turn: one per failed or empty call, failed first.
 * `cards` is the turn's citation model, for naming a document as its card does.
 */
export function openPoints(
  t: Translator,
  rounds: readonly WorkRound[],
  cards: readonly CitedDocument[] = []
): string[] {
  const rows = rounds.flatMap(allRows)
  const ordered = [
    ...rows.filter((row) => row.action.status === 'error'),
    ...rows.filter((row) => row.action.status === 'empty' || isInterrupted(row)),
  ]
  return [...new Set(ordered.flatMap((row) => openPoint(t, row, cards) ?? []))]
}

export interface DerivationOverview {
  /** The rounds a reader sees as „Schritt N“; the prefetch is none of them. */
  steps: number
  /** Documents the answer cites. */
  cited: number
  /** Calls that failed. */
  failed: number
  /** Calls that found nothing or broke off: an open point each. */
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
    open: settled.filter((row) => row.action.status === 'empty' || isInterrupted(row)).length,
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
