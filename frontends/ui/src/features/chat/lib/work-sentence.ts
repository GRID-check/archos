/**
 * The words of one Herleitung row (ADR-0131), in three parts the row lays out
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

export type WorkTone = 'ok' | 'running' | 'empty' | 'error'

export interface WorkParts {
  /** What was done, muted: „Liest“. Empty when only a fallback sentence is known. */
  verb: string
  /** What it was done to: „Einreichplan EG.pdf, S. 2–3“. */
  object: string
  /** What it found, „läuft“, „kein Treffer“ or „fehlgeschlagen“; empty when the call counted nothing. */
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
  path
    .split(/[\\/]+/)
    .map((part) => part.trim())
    .filter(Boolean)
    .join(' › ')

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
  const { query, target } = action
  if (target && query)
    return t('thinking.work.object.queryIn', { target: breadcrumb(target), query })
  if (target) return breadcrumb(target)
  const shelf = shelfPhrase(t, action)
  if (!query) return shelf
  return shelf
    ? t('thinking.work.object.queryShelf', { query, shelf })
    : t('thinking.work.object.query', { query })
}

/** „Einreichplan EG.pdf, S. 2–3“, „OIB-RL 2, Pkt. 3.1“, „…, S. 2, oben rechts“. */
const placeObject = (
  t: Translator,
  target: string,
  pages: string | undefined,
  where?: string
): string => {
  if (!pages) return target
  if (isClause(pages)) return t('thinking.work.object.clause', { target, pages })
  const range = pageRange(pages)
  return where
    ? t('thinking.work.object.where', { target, pages: range, where })
    : t('thinking.work.object.pages', { target, pages: range })
}

/** The folded object: „7 Dokumente“, „3 Ordner“, „4 Suchen“. */
const foldedObject = (t: Translator, action: StoredAction, count: number): string => {
  if (action.verb === 'read' || action.verb === 'look')
    return t('thinking.work.many.documents', { count })
  if (action.verb === 'list') return t('thinking.work.many.folders', { count })
  return t('thinking.work.many.searches', { count })
}

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
        object: target ?? (query ? t('thinking.work.object.query', { query }) : ''),
      }
    case 'lookup':
    case 'web':
      return {
        verb: t(`thinking.work.verb.${verb}`),
        object: query ? t('thinking.work.object.query', { query }) : '',
      }
    case 'model':
      return { verb: t('thinking.work.verb.model'), object: query ?? '' }
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
  // A call known only by its verb reads as one sentence: the fallback, in the object's ink.
  const parts = object
    ? { verb: named.verb, object }
    : { verb: '', object: t(`thinking.work.fallback.${action.verb}`) }
  if (running) return { ...parts, result: t('thinking.work.running'), tone: 'running' }
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

/** The row as one sentence, for its accessible name: „Liest Einreichplan EG.pdf, S. 2–3: 2 Stellen“. */
export const workPartsText = (parts: WorkParts): string => {
  const head = [parts.verb, parts.object].filter(Boolean).join(' ')
  return parts.result ? `${head}: ${parts.result}` : head
}
