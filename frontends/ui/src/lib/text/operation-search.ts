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
 * How well `op` answers the query; 0 when it answers no word. A blank query scores every operation 1; text
 * with no usable word in it (`a`, `(+)$`) scores every operation 0.
 */
export function operationScorer(query: string): (op: SearchableOperation) => number {
  const groups = searchWordGroups(query)
  const listsAll = query.trim() === ''
  return (op) => {
    if (groups.length === 0) return listsAll ? 1 : 0
    const name = foldSearchText(op.name)
    const segments = name.split('-')
    const summary = foldSearchText(op.summary)
    const description = foldSearchText(op.description)
    const scoreOf = (word: string): number =>
      (name.includes(word) ? 3 : 0) +
      (segments.includes(word) ? 1 : 0) +
      (summary.includes(word) ? 2 : 0) +
      (description.includes(word) ? 1 : 0)
    let total = 0
    let matched = 0
    for (const group of groups) {
      const score = Math.max(...group.map(scoreOf))
      if (score > 0) matched += 1
      total += score
    }
    // An operation that answers every word beats one that answers a single word often.
    return total + (matched === groups.length ? 5 : 0)
  }
}
