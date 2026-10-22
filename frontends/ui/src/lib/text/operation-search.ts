/**
 * Ranking the agent catalog's operations by the words of a request, in either
 * of the office's languages (ADR-0123).
 *
 * The catalog names and describes every operation in English
 * (`project-member-add`, "Add a person to a project"), and the people Piloti
 * works for ask in German. The ranking `discovery.ts` was first written with
 * split a query on `[^a-z0-9]`, so „hinzufügen" became the fragments `hinzuf`
 * and `gen`, and even a clean German word could never meet an English summary:
 * „Mitglied zu Projekt hinzufügen" ranked `project-summary-generate` first, and
 * the agent spent its rounds searching again (ADR-0123 has the numbers).
 * `discovery.ts` ranks with this module now.
 *
 * Two causes, two fixes, both here:
 *
 * - **Letters.** Query and catalog text are folded the same way
 *   ({@link latinize}: `ä` → `ae`, `ß` → `ss`, accents dropped) before they are
 *   split, so no letter outside ASCII cuts a word in two.
 * - **Vocabulary.** Each query word stands for a GROUP: the word itself and the
 *   catalog words the office's term means
 *   (`operation-search-vocabulary.json`, domain data the eval's fixture server
 *   reads too). A group scores by its best member, and the bonus for an
 *   operation that answers every word counts groups, so a German word and its
 *   English meaning are one word, not two that can never both match.
 *
 * Plain words only, never a pattern built from the caller's text: one
 * catastrophic regular expression would hold the event loop for every tenant.
 */

import { latinize } from './latinize'
import vocabulary from './operation-search-vocabulary.json'

/** What ranking reads of an operation: a catalog operation and a backend operation both have it. */
export interface SearchableOperation {
  name: string
  summary: string
  description: string
}

/**
 * A vocabulary key this long or longer also matches itself inflected (`mitglieder` is `mitglied` + `er`),
 * never any longer word it starts: `auftraggeber` is not `auftrag`, `rechtzeitig` not `recht`.
 */
export const PREFIX_MATCH_MIN_LENGTH = 5

const TERMS: ReadonlyArray<readonly [string, readonly string[]]> = Object.entries(vocabulary.terms)

/** The endings an inflected word may add to a key (`vocabulary.inflections`), `''` among them. */
const INFLECTIONS: ReadonlySet<string> = new Set(vocabulary.inflections)

/** Whether `word` is `term`, or `term` inflected when the term is long enough to be inflected. */
function isFormOf(word: string, term: string): boolean {
  if (term.length < PREFIX_MATCH_MIN_LENGTH) return word === term
  return word.startsWith(term) && INFLECTIONS.has(word.slice(term.length))
}

/** Lower case, German letters spelled out, accents dropped: the form query and catalog are compared in. */
export function foldSearchText(text: string): string {
  return latinize(text).toLowerCase()
}

function meaningsOf(word: string): string[] {
  const found = new Set<string>()
  for (const [term, meanings] of TERMS) {
    if (isFormOf(word, term)) for (const meaning of meanings) found.add(meaning)
  }
  found.delete(word)
  return [...found]
}

/** A word this long may be a compound of two vocabulary terms: `projektmitglieder`. */
export const COMPOUND_MIN_LENGTH = 10

/** A word of one letter matches nearly every operation (`(a+)+$` found all 248) and ranks nothing. */
export const MIN_WORD_LENGTH = 2

/**
 * The vocabulary terms a compound is made of, in order, when it holds two or
 * more that do not overlap (`projektmitglieder` → `projekt`, `mitglied`); empty
 * otherwise. Only terms long enough to match by prefix, so `neu` inside
 * `erneuern` is never one.
 */
function compoundParts(word: string): string[] {
  if (word.length < COMPOUND_MIN_LENGTH) return []
  const found: { at: number; term: string }[] = []
  for (const [term] of TERMS) {
    if (term.length < PREFIX_MATCH_MIN_LENGTH) continue
    const at = word.indexOf(term)
    if (at >= 0) found.push({ at, term })
  }
  found.sort((a, b) => a.at - b.at || b.term.length - a.term.length)
  const parts: string[] = []
  let end = 0
  for (const { at, term } of found) {
    if (at < end) continue
    parts.push(term)
    end = at + term.length
  }
  return parts.length >= 2 ? parts : []
}

/**
 * The query as word groups: each folded word, followed by what the office's
 * term means in the catalog's words. `Mitglied hinzufügen` →
 * `[['mitglied', 'member'], ['hinzufuegen', 'add']]`. A compound of two terms
 * is two groups: `Projektmitglieder` → `[['projekt', 'project'], ['mitglied', 'member']]`.
 */
export function searchWordGroups(query: string): string[][] {
  const words = foldSearchText(query)
    .split(/[^a-z0-9]+/)
    .filter((word) => word.length >= MIN_WORD_LENGTH)
  return words.flatMap((word) => {
    const parts = compoundParts(word)
    if (parts.length > 0) return parts.map((part) => [part, ...meaningsOf(part)])
    return [[word, ...meaningsOf(word)]]
  })
}

/**
 * Words that carry no meaning a catalog could match: the question's grammar
 * (`which`, `what`, `der`) and the person asking (`me`, `my`, `mir`). Matched
 * by substring they used to rank by accident (`to` inside `restore` put
 * project-restore first for "which OIB guidelines apply to project"); matched
 * whole they would still add a weight every operation shares. A query of
 * nothing but these keeps them, so "what is new" still finds something.
 */
export const STOPWORDS: ReadonlySet<string> = new Set([
  'a', 'about', 'all', 'am', 'an', 'and', 'any', 'are', 'as', 'at', 'be', 'by', 'can', 'do', 'does', 'for',
  'from', 'get', 'give', 'has', 'have', 'how', 'i', 'in', 'into', 'is', 'it', 'its', 'me', 'my', 'of', 'on', 'or',
  'our', 'please', 'show', 'some', 'tell', 'that', 'the', 'their', 'there', 'this', 'to', 'under', 'us', 'want',
  'was', 'we', 'what', 'when', 'where', 'which', 'who', 'why', 'will', 'with', 'you', 'your',
  'auf', 'aus', 'bei', 'bitte', 'das', 'dem', 'den', 'der', 'des', 'die', 'ein', 'eine', 'einem', 'einen', 'einer',
  'eines', 'es', 'fuer', 'gibt', 'hat', 'ich', 'im', 'ist', 'mir', 'mit', 'sagt', 'sind', 'und', 'unser', 'unsere',
  'von', 'vom', 'was', 'welche', 'welcher', 'welches', 'wer', 'wie', 'wir', 'zu', 'zum', 'zur',
])

/** A word with its common English endings removed, so `guidelines` meets `guideline` and `failed` meets `fail`. */
export function stemSearchWord(word: string): string {
  if (word.length <= 4) return word
  if (word.endsWith('ies')) return `${word.slice(0, -3)}y`
  if (word.endsWith('ing') && word.length >= 6) return word.slice(0, -3)
  if (word.endsWith('ed') && word.length >= 5) return word.slice(0, -2)
  // `-es` only where English adds it (`searches`, `boxes`); `guidelines` is `guideline` + `s`.
  if (/(?:ss|x|z|ch|sh)es$/.test(word)) return word.slice(0, -2)
  if (word.endsWith('s') && !word.endsWith('ss')) return word.slice(0, -1)
  return word
}

/** The words of catalog or query text, folded, as {@link searchWordGroups} splits them. */
function wordsOf(text: string): string[] {
  return foldSearchText(text)
    .split(/[^a-z0-9]+/)
    .filter((word) => word.length >= MIN_WORD_LENGTH)
}

/** A query word this long also finds the longer words it begins: `ingest` finds `ingestion`. */
export const WORD_PREFIX_MIN_LENGTH = 4

/**
 * Whether the query word `word` is the catalog word `token`: the same word, the
 * same stem, or (for a word long enough to mean something on its own) the start
 * of it. Never a fragment inside a word: `to` is not in `restore`.
 */
function wordMatches(word: string, token: string): boolean {
  if (token === word) return true
  if (word.length >= WORD_PREFIX_MIN_LENGTH && token.startsWith(word)) return true
  return stemSearchWord(token) === stemSearchWord(word)
}

/** An operation's text split once into the fields ranking weighs. */
interface IndexedOperation {
  name: readonly string[]
  summary: readonly string[]
  description: readonly string[]
}

function indexOperation(op: SearchableOperation): IndexedOperation {
  return { name: wordsOf(op.name), summary: wordsOf(op.summary), description: wordsOf(op.description) }
}

const contains = (words: readonly string[], word: string): boolean => words.some((token) => wordMatches(word, token))

/**
 * How much finding `word` says about an operation, from how few of `corpus` it
 * occurs in (inverse document frequency, as BM25 weighs a term): `project`,
 * in most of the catalog, says little; `oib`, in a handful, says a lot. Without
 * a corpus every word weighs 1.
 */
function rarityOf(corpus: readonly IndexedOperation[]): (word: string) => number {
  if (corpus.length === 0) return () => 1
  const cache = new Map<string, number>()
  return (word) => {
    const known = cache.get(word)
    if (known !== undefined) return known
    const df = corpus.filter((op) => contains(op.name, word) || contains(op.summary, word) || contains(op.description, word)).length
    const weight = Math.log(1 + corpus.length / (1 + df))
    cache.set(word, weight)
    return weight
  }
}

/**
 * How well `op` answers the query; 0 when it answers no word. A blank query
 * scores every operation 1; text with no usable word in it (`a`, `(+)$`)
 * scores every operation 0.
 *
 * Each word group scores by its best member: where the word occurs (name 3,
 * summary 2, description 1, and 1 more when it opens the summary, the verb an
 * operation is for: "Ask Piloti a question"), times its rarity across `corpus`.
 * The sum is scaled by the share of groups the operation answers, so one
 * answering every word beats one answering a common word often. Pass the
 * operations being ranked as `corpus`; without it every word weighs the same.
 */
export function operationScorer(
  query: string,
  corpus: readonly SearchableOperation[] = [],
): (op: SearchableOperation) => number {
  const all = searchWordGroups(query)
  const meaningful = all.filter((group) => !STOPWORDS.has(group[0]))
  const groups = meaningful.length > 0 ? meaningful : all
  const listsAll = query.trim() === ''
  const rarity = rarityOf(corpus.map(indexOperation))
  return (op) => {
    if (groups.length === 0) return listsAll ? 1 : 0
    const indexed = indexOperation(op)
    const lead = indexed.summary[0]
    const placeOf = (word: string): number =>
      (contains(indexed.name, word) ? 3 : 0) +
      (contains(indexed.summary, word) ? 2 : 0) +
      (contains(indexed.description, word) ? 1 : 0) +
      (lead !== undefined && wordMatches(word, lead) ? 1 : 0)
    let total = 0
    let matched = 0
    for (const group of groups) {
      const score = Math.max(...group.map((word) => placeOf(word) * rarity(word)))
      if (score > 0) matched += 1
      total += score
    }
    // Rounded so the eval's Python mirror, whose logarithm may differ in the last bit, orders ties the same.
    return Math.round(total * (matched / groups.length) * 1e6) / 1e6
  }
}
