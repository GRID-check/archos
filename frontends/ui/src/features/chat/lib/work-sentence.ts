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
 *
 * A call over Piloti's filesystem (ADR-0133) names its place by `mount` and
 * the folder inside it, never by its path, and counts files: „Durchsucht 03
 * Einreichung wörtlich nach „Brandabschnitt“ · 14 Treffer in 3 Dateien“,
 * „Öffnet das Projekt · leer“, „Sucht in allen Ablagen nach PDF-Dateien“. A
 * literal search that could not search everything says so (a dashed shape, and
 * what that means on a line of its own): it never looks complete.
 */

import type { Translator } from '@/i18n'
import type { ActionMount, StoredAction } from '@/lib/conversations/message-provenance'
import { bindAbbreviations } from './document-names'

/** `interrupted`: a call stored as running whose turn ended (Stop, an error, a closed stream). */
export type WorkTone = 'ok' | 'running' | 'empty' | 'error' | 'interrupted' | 'incomplete'

export interface WorkParts {
  /** What was done, muted: „Liest“. Empty when only a fallback sentence is known. */
  verb: string
  /** What it was done to: „Einreichplan EG.pdf, S. 2–3“. */
  object: string
  /** What it found, „läuft“, „kein Treffer“, „abgebrochen“ or „fehlgeschlagen“; empty when the call counted nothing. */
  result: string
  tone: WorkTone
  /**
   * What the result means for the answer, on a muted line of its own: after
   * „fehlgeschlagen“ that the answer does not rest on it, after „unvollständig“
   * that a no is no no. Absent on every other row.
   */
  note?: string
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

/** Where a path-based call looked: its place and the folder inside it (`''` at the place's root). */
export interface ActionPlace {
  mount: ActionMount
  folder: string
}

/** The place of a filesystem call, or null for every other call. */
export const actionPlace = (action: StoredAction): ActionPlace | null =>
  action.mount
    ? { mount: action.mount, folder: (action.target ?? '').replace(/^\/+|\/+$/g, '') }
    : null

/**
 * A project's folders are what an architect means by „the folders“: they go by
 * their breadcrumb alone. A folder of another place is named under that place,
 * in the form the sentence needs: „die Büroablage › Vorlagen“, „in der
 * Büroablage › Vorlagen“, and in quotes „Büroablage › Vorlagen“.
 */
const bareFolder = (place: ActionPlace): boolean =>
  place.mount === 'project' || place.mount === 'estate'

/** A folder as a name in quotes, without an article: „03 Einreichung“, „Büroablage › Vorlagen“. */
export const placeLabel = (t: Translator, place: ActionPlace): string => {
  const crumbs = breadcrumb(place.folder)
  if (!place.folder) return t(`thinking.work.place.${place.mount}`)
  return bareFolder(place)
    ? crumbs
    : t('thinking.work.place.folderIn', {
        place: t(`thinking.work.place.crumb.${place.mount}`),
        folder: crumbs,
      })
}

/** The place as the object of a verb: „das Projekt“, „03 Einreichung › Pläne“, „die Büroablage › Vorlagen“. */
export const placeName = (t: Translator, place: ActionPlace): string => {
  const named = t(`thinking.work.place.${place.mount}`)
  if (!place.folder) return named
  const folder = breadcrumb(place.folder)
  return bareFolder(place) ? folder : t('thinking.work.place.folderIn', { place: named, folder })
}

/** The place after its preposition: „im Projekt“, „in 03 Einreichung“, „in der Büroablage › Vorlagen“. */
export const placeIn = (t: Translator, place: ActionPlace): string => {
  const named = t(`thinking.work.placeIn.${place.mount}`)
  if (!place.folder) return named
  const folder = breadcrumb(place.folder)
  return bareFolder(place)
    ? t('thinking.work.placeIn.folder', { folder })
    : t('thinking.work.place.folderIn', { place: named, folder })
}

/** `*.pdf`, `**\/*.dwg`: files of one type. */
const GLOB_EXTENSION = /^(?:\*\*\/)?\*\.([A-Za-z0-9]{1,5})$/
/** `*Brandschutz*`, `**\/*Plan*.pdf`: files with a word in their name, of one type or any. */
const GLOB_WORD = /^(?:\*\*\/)?\*([^*?[\]{}/\\]+)\*(?:\.([A-Za-z0-9]{1,5}))?$/

/**
 * What a file-name search looks for, in words where its pattern is simple
 * („PDF-Dateien“, „Dateien mit „Brandschutz“ im Namen“), and by the pattern
 * itself where it is not („Dateien „EP-0?_*.pdf““).
 */
export function namePattern(t: Translator, pattern: string): string {
  const trimmed = pattern.trim()
  const typed = GLOB_EXTENSION.exec(trimmed)
  if (typed) return t('thinking.work.object.namesWhat.ext', { ext: typed[1].toUpperCase() })
  const named = GLOB_WORD.exec(trimmed)
  const word = named?.[1].trim()
  if (named && word) {
    return named[2]
      ? t('thinking.work.object.namesWhat.extWord', { ext: named[2].toUpperCase(), word })
      : t('thinking.work.object.namesWhat.word', { word })
  }
  return t('thinking.work.object.namesWhat.pattern', { query: quoteQuery(t, trimmed) })
}

/** A pattern of plain words or'ed together (`EI 90|REI 90`): no character in it means more than itself. */
const REGEX_WORDS = /^[\p{L}\p{N} -]+(?:\|[\p{L}\p{N} -]+)*$/u

/** The words a regex looks for when it is only words, or'ed; null for a real pattern. */
export const regexWords = (pattern: string): string[] | null =>
  REGEX_WORDS.test(pattern.trim())
    ? pattern
        .split('|')
        .map((word) => word.trim())
        .filter(Boolean)
    : null

/** „„EI 90““, „„EI 90“ oder „REI 90““, „„a“, „b“ oder „c““. */
const wordList = (t: Translator, words: readonly string[]): string => {
  const quoted = words.map((word) => t('thinking.work.object.query', { query: word }))
  const last = quoted.pop() ?? ''
  return quoted.length ? `${quoted.join(', ')} ${t('thinking.work.object.or')} ${last}` : last
}

/**
 * A regex of words matches as the literal search does only where the literal
 * search's folding adds nothing: the store compiles a person's regex
 * case-insensitively (`compile_user_regex`), but never folds „ü“ into „ue“ as
 * the literal search does. Words with an umlaut or ß are searched for, not
 * „wörtlich“.
 */
const FOLDED_LETTERS = /[äöüÄÖÜß]/

/** A filesystem search's object: wörtlich, by the words a simple regex names, or by its pattern. */
const grepObject = (t: Translator, action: StoredAction, place: ActionPlace): string => {
  const words = action.mode === 'regex' && action.query ? regexWords(action.query) : null
  const where = placeName(t, place)
  if (words) {
    const literal = !words.some((word) => FOLDED_LETTERS.test(word))
    return t(literal ? 'thinking.work.object.grepAny' : 'thinking.work.object.grepWords', {
      place: where,
      words: wordList(t, words),
    })
  }
  const query = action.query ? quoteQuery(t, action.query) : ''
  return t(
    action.mode === 'regex' ? 'thinking.work.object.grepRegex' : 'thinking.work.object.grepExact',
    { place: where, query }
  )
}

/**
 * What a row is, finer than its verb where the words differ: a literal search
 * of the filesystem (`grep`) and a search by file name (`glob`, a listing with
 * a pattern) read differently from a ranked search and a folder listing.
 */
export type WorkSentenceKind = StoredAction['verb'] | 'grep' | 'glob'

export const sentenceKind = (action: StoredAction): WorkSentenceKind => {
  if (!action.mount) return action.verb
  if (action.verb === 'search' && action.mode !== 'meaning') return 'grep'
  if (action.verb === 'list' && action.query) return 'glob'
  return action.verb
}

/** A filesystem call's verb and object; null for any other call. */
const placeVerbAndObject = (
  t: Translator,
  action: StoredAction
): { verb: string; object: string } | null => {
  const place = actionPlace(action)
  if (!place) return null
  switch (sentenceKind(action)) {
    case 'grep':
      return { verb: t('thinking.work.verb.grep'), object: grepObject(t, action, place) }
    case 'glob':
      return {
        verb: t('thinking.work.verb.glob'),
        object: t('thinking.work.object.names', {
          what: namePattern(t, action.query ?? ''),
          place: placeIn(t, place),
        }),
      }
    case 'list':
      return { verb: t('thinking.work.verb.list'), object: placeName(t, place) }
    default:
      return null
  }
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
const FOLD_KEEPS_VERB = new Set<WorkSentenceKind>(['read', 'look', 'list'])

/** The folded object of a search-like verb: no verb, the count says it („4 Suchen im RIS“). */
const FOLDED_KEYS: Record<WorkSentenceKind, string> = {
  grep: 'searches',
  glob: 'nameSearches',
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
  t(`thinking.work.many.${FOLDED_KEYS[sentenceKind(action)]}`, { count })

const verbAndObject = (
  t: Translator,
  action: StoredAction,
  where: string | undefined
): { verb: string; object: string } => {
  const placed = placeVerbAndObject(t, action)
  if (placed) return placed
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
    // A folder that is there and holds nothing: found, and empty („Öffnet das Projekt · leer“).
    if (!action.query && files === 0 && !folders) return t('thinking.work.found.emptyFolder')
    if (action.mount === 'estate' && !action.query && files !== undefined && folders !== undefined)
      return t('thinking.work.found.places', { files, folders })
    // A zero beside a count is noise („9 Dateien, 0 Ordner“): the listing says what is there.
    if (files !== undefined && folders !== undefined && files > 0 && folders > 0)
      return t('thinking.work.found.listing', { files, folders })
    if (folders !== undefined && folders > 0 && !files)
      return t('thinking.work.found.folders', { count: folders })
    if (files !== undefined) return t('thinking.work.found.files', { count: files })
    if (folders !== undefined) return t('thinking.work.found.folders', { count: folders })
    return ''
  }
  if (action.verb === 'read' || action.verb === 'look') {
    return hits !== undefined ? t('thinking.work.found.passages', { count: hits }) : ''
  }
  if (hits !== undefined) {
    // On the filesystem every count counts files, as its listings do: one noun for one thing.
    const key = action.mount ? 'hitsFiles' : 'hitsDocuments'
    return documents !== undefined
      ? t(`thinking.work.found.${key}`, { hits, documents })
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
  const verb = folded && !FOLD_KEEPS_VERB.has(sentenceKind(action)) ? '' : named.verb
  // A call known only by its verb reads as one sentence: the fallback, in the object's ink.
  const parts = object
    ? { verb, object }
    : { verb: '', object: t(`thinking.work.fallback.${action.verb}`) }
  if (running) return { ...parts, result: t('thinking.work.running'), tone: 'running' }
  // Stored as running, and the turn is over: it never settled, and is no result.
  if (action.status === 'running')
    return { ...parts, result: t('thinking.work.interrupted'), tone: 'interrupted' }
  if (action.status === 'error')
    return {
      ...parts,
      result: t('thinking.work.failed'),
      tone: 'error',
      note: t('thinking.work.failedNote'),
    }
  if (action.status === 'empty') {
    const result = emptyResult(t, action)
    return action.incomplete
      ? { ...parts, ...incomplete(t, result, false) }
      : { ...parts, result, tone: 'empty' }
  }
  const found = foundOf(t, action, folded ? folded.counts : action.counts)
  if (action.incomplete) return { ...parts, ...incomplete(t, found, true) }
  const short = reading && reading.length <= MAX_READING_RESULT_CHARS ? reading : ''
  return { ...parts, result: found || (action.verb === 'look' ? short : ''), tone: 'ok' }
}

/**
 * What a call that found nothing says: a folder or document the call named
 * that is not there („nicht gefunden“, only when the call says `missing`), a
 * name search that no file matched, a search where it looked („kein Treffer in
 * 41 Dateien“ when it counted them). A folder that is there and empty is no
 * empty call: it settles `ok` and reads „leer“.
 */
const emptyResult = (t: Translator, action: StoredAction): string => {
  if (action.missing) return t('thinking.work.notFound')
  if (sentenceKind(action) === 'glob') return t('thinking.work.noFile')
  if (!SEARCHING.has(action.verb)) return t('thinking.work.nothingFound')
  const searched = action.counts?.searched
  if (!searched) return t('thinking.work.noHit')
  return t(action.mount ? 'thinking.work.noHitInFiles' : 'thinking.work.noHitIn', { count: searched })
}

/**
 * A search that could not search everything: what it found, and on its own line
 * what that means. The dashed shape and the note mark it; the count stays a
 * count, with „unvollständig“ only where there is no count to show.
 */
const incomplete = (
  t: Translator,
  found: string,
  hit: boolean
): Pick<WorkParts, 'result' | 'tone' | 'note'> => ({
  result: found || t('thinking.work.incomplete'),
  tone: 'incomplete',
  note: t(hit ? 'thinking.work.incompleteNote.hits' : 'thinking.work.incompleteNote.noHit'),
})

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
    ? t(`thinking.work.done.${sentenceKind(action)}`, { name: object })
    : t(`thinking.work.doneFallback.${action.verb}`)
}

/** The row as one sentence, for its accessible name: „Liest Einreichplan EG.pdf, S. 2–3: 2 Stellen“. */
export const workPartsText = (parts: WorkParts): string => {
  const head = [parts.verb, parts.object].filter(Boolean).join(' ')
  const said = parts.result ? `${head}: ${parts.result}` : head
  // „unvollständig“ alone does not say what it means; a screen reader hears the note with it.
  return parts.tone === 'incomplete' && parts.note ? `${said} (${parts.note})` : said
}
