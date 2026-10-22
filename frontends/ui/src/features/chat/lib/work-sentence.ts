/**
 * The words of one Herleitung row (ADR-0132), in three parts the row lays out
 * apart: the verb („Sucht wörtlich“, muted), the object („„Brandabschnitt“
 * im Projekt“) and the result („14 Treffer · 3 Dokumente“, right-aligned).
 *
 * Built from the typed action, never from a tool's text. Every word is a
 * dictionary key (`chat.thinking.work.*`); this only chooses which, so a count
 * the call does not report drops its clause instead of printing „0“. A search
 * that found nothing says where it looked, because the object already names
 * the place: „Sucht in OIB-RL 2: „Brandabschnitt Tiefgarage“ · kein Treffer“.
 */

import type { Translator } from '@/i18n'
import type { StoredAction } from '@/lib/conversations/message-provenance'
import { bindAbbreviations } from './document-names'

/** `interrupted`: a call stored as running whose turn ended (Stop, an error, a closed stream). */
export type WorkTone = 'ok' | 'running' | 'empty' | 'error' | 'interrupted'

export interface WorkParts {
  /** What was done, muted: „Liest“. Empty when only a fallback sentence is known. */
  verb: string
  /** What it was done to: „Einreichplan EG.pdf, S. 2–3“. */
  object: string
  /** What it found, „läuft“, „kein Treffer“, „abgebrochen“ or „fehlgeschlagen“; empty when the call counted nothing. */
  result: string
  tone: WorkTone
}

/** What one row stands for when same-kind calls are folded into it. */
export interface WorkFold {
  /** How many calls the row stands for. */
  count: number
  /** Their counts, summed: what the folded row reports. */
  counts: StoredAction['counts']
}

const SHELF_KEYS: Record<string, string> = {
  project: 'project',
  office: 'office',
  office_shelf: 'office',
  base: 'base',
  web: 'web',
  session: 'session',
}

/** A look's reading longer than this is no row result: the row's right edge holds a figure, not a sentence. */
export const MAX_READING_RESULT_CHARS = 48

/** Verbs whose empty outcome is a search that hit nothing; the rest found nothing to read. */
const SEARCHING = new Set<StoredAction['verb']>(['search', 'lookup', 'law', 'web'])

/** „03 Einreichung/Pläne“ as „03 Einreichung › Pläne“. */
export const breadcrumb = (path: string): string =>
  bindAbbreviations(
    path
      .split(/[\\/]+/)
      .map((part) => part.trim())
      .filter(Boolean)
      .join(' › ')
  )

/** Double quotes of either language, opening or closing. */
const ANY_QUOTE = /["„“”«»]/
const WRAPPED = /^["„“«](.*)["“”»]$/
const INNER_PAIR = /["„“«]([^"„“”«»]*)["“”»]/g

/**
 * A query as it sits inside the row's own quotes: the outer quotes a model
 * often adds stripped, and quotes inside it turned into the inner pair
 * (‚…‘, in English ‘…’), so „„Brandabschnitt“ Tiefgarage“ never nests.
 */
export function quoteQuery(t: Translator, query: string): string {
  const trimmed = query.trim()
  const wrapped = WRAPPED.exec(trimmed)
  const bare = wrapped && !ANY_QUOTE.test(wrapped[1]) ? wrapped[1].trim() : trimmed
  return bare.replace(INNER_PAIR, (_, inner: string) =>
    t('thinking.work.innerQuote', { text: inner })
  )
}

/** The nine places `page_region_words.where_on_the_page` names, by their German words. */
const REGION_KEYS: Record<string, string> = {
  'oben links': 'topLeft',
  'oben rechts': 'topRight',
  'oben in der Mitte': 'topCenter',
  'unten links': 'bottomLeft',
  'unten rechts': 'bottomRight',
  'unten in der Mitte': 'bottomCenter',
  'in der Mitte links': 'middleLeft',
  'in der Mitte rechts': 'middleRight',
  'in der Seitenmitte': 'pageCenter',
}

/** A look's region in the reader's language: the wire sends the German words. */
export const regionWords = (t: Translator, where: string): string => {
  const key = REGION_KEYS[where.trim()]
  return key ? t(`thinking.look.region.${key}`) : where
}

const isClause = (pages: string): boolean => /^\s*pkt/i.test(pages)

/** The first page of „2-3“ or „2, 4“; null for a Punkt („Pkt. 3.5“) or nothing. */
export const firstPage = (pages: string | undefined): number | null => {
  if (!pages || isClause(pages)) return null
  const match = /\d+/.exec(pages)
  const page = match ? Number(match[0]) : 0
  return page >= 1 ? page : null
}

/** A page range as typeset: „2-3“ → „2–3“. */
export const pageRange = (pages: string): string => pages.replace(/(\d)\s*-\s*(\d)/g, '$1–$2')

const shelfPhrase = (t: Translator, action: StoredAction): string => {
  const key = action.shelf ? SHELF_KEYS[action.shelf.toLowerCase()] : undefined
  return key ? t(`thinking.work.shelf.${key}`) : ''
}

/** „Sucht“, „Sucht wörtlich“, „Sucht nach Muster“, and each with „in“ when the search names its document or folder. */
const searchVerb = (t: Translator, action: StoredAction): string => {
  const mode = action.mode === 'exact' ? 'Exact' : action.mode === 'regex' ? 'Regex' : ''
  return t(`thinking.work.verb.search${mode}${action.target ? 'In' : ''}`)
}

const searchObject = (t: Translator, action: StoredAction): string => {
  const { target } = action
  const query = action.query ? quoteQuery(t, action.query) : ''
  if (target && query)
    return t('thinking.work.object.queryIn', { target: breadcrumb(target), query })
  if (target) return breadcrumb(target)
  const shelf = shelfPhrase(t, action)
  if (!query) return shelf
  return shelf
    ? t('thinking.work.object.queryShelf', { query, shelf })
    : t('thinking.work.object.query', { query })
}

/** „„Wiener Garagengesetz““ as the row quotes it, or nothing without a query. */
const quotedQuery = (t: Translator, query: string | undefined): string =>
  query ? t('thinking.work.object.query', { query: quoteQuery(t, query) }) : ''

/** „Einreichplan EG.pdf, S. 2–3“, „OIB-RL 2, Pkt. 3.1“, „…, S. 2, oben rechts“. */
const placeObject = (
  t: Translator,
  target: string,
  pages: string | undefined,
  where?: string
): string => {
  const name = bindAbbreviations(target)
  if (!pages) return name
  if (isClause(pages))
    return t('thinking.work.object.clause', { target: name, pages: clauseLabel(pages) })
  const range = pageRange(pages)
  return where
    ? t('thinking.work.object.where', { target: name, pages: range, where: regionWords(t, where) })
    : t('thinking.work.object.pages', { target: name, pages: range })
}

/** „Pkt. 3.5“ with a no-break space, so the number never starts a line. */
const clauseLabel = (pages: string): string => pages.trim().replace(/^(pkt\.?)\s*/i, '$1\u00A0')

/** The verbs that only open, read or look: a folded row keeps the verb („Liest 7 Dokumente“). */
const FOLD_KEEPS_VERB = new Set<StoredAction['verb']>(['read', 'look', 'list'])

/** The folded object of a search-like verb: no verb, the count says it („4 Suchen im RIS“). */
const FOLDED_KEYS: Record<StoredAction['verb'], string> = {
  read: 'documents',
  look: 'documents',
  list: 'folders',
  search: 'searches',
  law: 'lawSearches',
  web: 'webSearches',
  lookup: 'lookupSearches',
  model: 'modelQueries',
  workspace: 'workspaceCalls',
}

/** The folded object: „7 Dokumente“, „3 Ordner“, „4 Suchen“. */
const foldedObject = (t: Translator, action: StoredAction, count: number): string =>
  t(`thinking.work.many.${FOLDED_KEYS[action.verb]}`, { count })

const verbAndObject = (
  t: Translator,
  action: StoredAction,
  where: string | undefined
): { verb: string; object: string } => {
  const { verb, query, target, pages } = action
  switch (verb) {
    case 'search':
      return { verb: searchVerb(t, action), object: searchObject(t, action) }
    case 'list':
      return { verb: t('thinking.work.verb.list'), object: target ? breadcrumb(target) : '' }
    case 'read':
      return {
        verb: t('thinking.work.verb.read'),
        object: target ? placeObject(t, target, pages) : '',
      }
    case 'look':
      return {
        verb: t('thinking.work.verb.look'),
        object: target ? placeObject(t, target, pages, where) : '',
      }
    case 'law':
      return {
        verb: t('thinking.work.verb.law'),
        object: target ? bindAbbreviations(target) : quotedQuery(t, query),
      }
    case 'lookup':
    case 'web':
    case 'model':
      return { verb: t(`thinking.work.verb.${verb}`), object: quotedQuery(t, query) }
    case 'workspace':
      return { verb: t('thinking.work.verb.workspace'), object: target ?? '' }
  }
}

/** What the call found, from the counts it reported; empty when it reported none worth a clause. */
const foundOf = (t: Translator, action: StoredAction, counts: StoredAction['counts']): string => {
  const { hits, documents, files, folders } = counts ?? {}
  if (action.verb === 'list') {
    if (files !== undefined && folders !== undefined)
      return t('thinking.work.found.listing', { files, folders })
    if (files !== undefined) return t('thinking.work.found.files', { count: files })
    if (folders !== undefined) return t('thinking.work.found.folders', { count: folders })
    return ''
  }
  if (action.verb === 'read' || action.verb === 'look') {
    return hits !== undefined ? t('thinking.work.found.places', { count: hits }) : ''
  }
  if (hits !== undefined) {
    return documents !== undefined
      ? t('thinking.work.found.hitsDocuments', { hits, documents })
      : t('thinking.work.found.hits', { count: hits })
  }
  return documents !== undefined ? t('thinking.work.found.documents', { count: documents }) : ''
}

/**
 * The parts of a row. `running` is the row's own state (a stored row that
 * never settled is not running once the turn ended). `reading` is what a look
 * read off, which is its result when it fits a row's right edge.
 */
export function workParts(
  t: Translator,
  action: StoredAction,
  options: { running?: boolean; fold?: WorkFold; where?: string; reading?: string } = {}
): WorkParts {
  const { running = false, fold, where, reading } = options
  const folded = fold && fold.count > 1 ? fold : undefined
  const named = verbAndObject(t, action, where)
  const object = folded ? foldedObject(t, action, folded.count) : named.object
  const verb = folded && !FOLD_KEEPS_VERB.has(action.verb) ? '' : named.verb
  // A call known only by its verb reads as one sentence: the fallback, in the object's ink.
  const parts = object
    ? { verb, object }
    : { verb: '', object: t(`thinking.work.fallback.${action.verb}`) }
  if (running) return { ...parts, result: t('thinking.work.running'), tone: 'running' }
  // Stored as running, and the turn is over: it never settled, and is no result.
  if (action.status === 'running')
    return { ...parts, result: t('thinking.work.interrupted'), tone: 'interrupted' }
  if (action.status === 'error')
    return { ...parts, result: t('thinking.work.failed'), tone: 'error' }
  if (action.status === 'empty') {
    const word = SEARCHING.has(action.verb) ? 'noHit' : 'nothingFound'
    return { ...parts, result: t(`thinking.work.${word}`), tone: 'empty' }
  }
  const found = foundOf(t, action, folded ? folded.counts : action.counts)
  const short = reading && reading.length <= MAX_READING_RESULT_CHARS ? reading : ''
  return { ...parts, result: found || (action.verb === 'look' ? short : ''), tone: 'ok' }
}

/**
 * The settled head of a turn that made one call, in the past: „Gelesen:
 * Brandschutzkonzept“. `name` is the document's short name when a card has
 * one; else the call's own object stands. A call known only by its verb says
 * the past fallback („Ein Dokument gelesen“).
 */
export function settledHead(t: Translator, action: StoredAction, name?: string): string {
  const parts = workParts(t, action)
  const object = name || (parts.verb ? parts.object : '')
  return object
    ? t(`thinking.work.done.${action.verb}`, { name: object })
    : t(`thinking.work.doneFallback.${action.verb}`)
}

/** The row as one sentence, for its accessible name: „Liest Einreichplan EG.pdf, S. 2–3: 2 Stellen“. */
export const workPartsText = (parts: WorkParts): string => {
  const head = [parts.verb, parts.object].filter(Boolean).join(' ')
  return parts.result ? `${head}: ${parts.result}` : head
}
