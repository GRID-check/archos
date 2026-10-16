/**
 * The content screen in TypeScript: the office's content terms and number
 * detectors, found and masked in a text (ADR-0086, "Chat messages are screened
 * too").
 *
 * The composer runs it before a chat message leaves the browser, and the BFF
 * runs it on every user message it stores, so what a person typed reaches
 * neither a model nor the stored history with an IBAN in it. It is the twin of
 * `aiq_agent.common.content_screen`, which the ingest job and the chat socket
 * run. Both read the ONE shared fixture, `tests/fixtures/content_screen_cases.json`
 * at the repository root, and must give the same matches, masked text and
 * findings for every case. Change one and the other's spec fails.
 *
 * The twins agree by construction: neither uses its runtime's own idea of
 * whitespace (`\s` differs between the two), case folding or digits, and the
 * detectors are the same small parsers on both sides, with regular expressions
 * only to find where a candidate may start. The Python module's docstring is
 * the full statement of the rules; in one line each:
 *  - Whitespace is `SCREENING_WHITESPACE`, Unicode's `White_Space` property.
 *    A word character is a letter or a number (`\p{L}`, `\p{N}`). A digit is any
 *    `\p{Nd}`, read as its value (`decimalDigitValue`).
 *  - The fold is `foldForScreening` (`./name-screen`: NFKC, lowercase, umlauts)
 *    with final sigma as sigma, applied per character and its combining marks,
 *    so a span in the folded text maps back to the characters it came from and
 *    a decomposed `ü` folds like the composed one.
 *  - Every rule runs on the text as a person reads it (`read`): invisible
 *    characters (`SCREENING_IGNORABLE`) left out, and a hyphen that breaks a word
 *    across ONE line break joined. A span is given back in the original text.
 *  - A term matches at a word start and may run on (`Honorar` finds
 *    `Honorarvereinbarung`), never inside a word (`Ehrenhonorar`, judged on the
 *    reading); its span runs to the end of that word. A multi-word term
 *    matches across any whitespace.
 *  - A detector counts only a checksum-valid number (IBAN mod 97 at its
 *    country's registered length, the Austrian social-security check digit,
 *    Luhn); the shapes around the checksum are wide (any case, any whitespace
 *    run, `-` or `.` between groups, a label against the number). A card is found
 *    by layout inside a run of digit groups (`cardsIn`), never across a tab.
 *    The digits of an IBAN are not also a card or a social-security number.
 *  - Placeholders are protected: a match overlapping one does not count, so
 *    masking a masked text changes nothing. Masking repeats until a pass finds
 *    nothing, because removing one number can expose another its digits were
 *    hiding.
 *
 * Pure and client-safe. Offsets are UTF-16 indices into the text given.
 */

import { foldForScreening } from './name-screen'
import { SCREENING_DETECTORS, type ScreeningDetector, type UploadScreeningPolicy } from './policy'

export type ContentScreenKind = ScreeningDetector | 'term'

/**
 * What a masked span is replaced with. Domain data, in German, defined once in
 * Python (`content_screen.PLACEHOLDERS`) and mirrored here; the shared fixture
 * holds both to the same strings.
 */
export const SCREENING_PLACEHOLDERS: Readonly<Record<ContentScreenKind, string>> = {
  iban: '[IBAN entfernt]',
  at_svnr: '[SV-Nummer entfernt]',
  credit_card: '[Kartennummer entfernt]',
  term: '[Begriff entfernt]',
}

const MAX_TERMS = 200
const MIN_TERM_CHARS = 2
const MAX_TERM_CHARS = 80
const MASK = '••••'

export interface ContentScreenRules {
  terms: readonly string[]
  detectors: readonly ScreeningDetector[]
  /** One per term, same order: the term's folded words, matched literally (`termMatches`). */
  patterns: readonly (readonly string[])[]
}

/** One match. `findSpans` gives it in the ORIGINAL text. */
export interface ContentSpan {
  kind: ContentScreenKind
  start: number
  end: number
  term?: string
  /** A masked sample of a detector's match; never the value. */
  sample?: string
}

/** What a mask removed, per rule. Carries the office's own term or a masked sample, never a matched value. */
export interface ContentFinding {
  kind: ContentScreenKind
  count: number
  term?: string
  sample?: string
}

export interface MaskedText {
  text: string
  findings: ContentFinding[]
}

// ------------------------------------------------------------ characters

/**
 * Unicode's `White_Space` property, all 25 code points: the one definition of
 * whitespace on both sides (Python's `content_screen.WHITESPACE`). Not `\s`,
 * which adds U+FEFF and drops U+0085.
 */
export const SCREENING_WHITESPACE =
  '\t\n\v\f\r \x85\xa0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a\u2028\u2029\u202f\u205f\u3000'
/** A run of `SCREENING_WHITESPACE`. */
const SPACE_RUN = /[\t-\r \x85\xa0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]+/u

const LETTER_OR_NUMBER = /[\p{L}\p{N}]/u
const WORD_CHAR = /[\p{L}\p{N}\p{M}]/u
const MARK = /\p{M}/u
const DECIMAL_DIGIT = /\p{Nd}/u
const ASCII_LETTER = /^[A-Za-z]$/
const FINAL_SIGMA = /ς/g

function isWhitespace(char: string): boolean {
  return char.length === 1 && SCREENING_WHITESPACE.includes(char)
}

/** The code point starting at `index`, or '' outside the text. */
function codePointAt(text: string, index: number): string {
  if (index < 0 || index >= text.length) return ''
  return String.fromCodePoint(text.codePointAt(index) ?? 0)
}

/** The code point that ends just before `index`, or '' at the start. */
function codePointBefore(text: string, index: number): string {
  if (index === 0) return ''
  const low = text.charCodeAt(index - 1)
  const isLowSurrogate = low >= 0xdc00 && low <= 0xdfff
  return isLowSurrogate && index >= 2 ? text.slice(index - 2, index) : text.slice(index - 1, index)
}

function wordCharAt(text: string, index: number): boolean {
  return LETTER_OR_NUMBER.test(codePointAt(text, index))
}

function wordCharBefore(text: string, index: number): boolean {
  return LETTER_OR_NUMBER.test(codePointBefore(text, index))
}

function isDecimalDigit(codePoint: number): boolean {
  return codePoint >= 0 && DECIMAL_DIGIT.test(String.fromCodePoint(codePoint))
}

/**
 * The value of a Unicode decimal digit (`\p{Nd}`), or `null` for any other
 * code point. JavaScript has no table for it, so it is derived: Unicode encodes
 * every decimal digit in runs of ten from zero to nine, and every contiguous
 * block of them starts at a zero, so the value is the distance from the block's
 * start, mod 10. The spec checks it against Python's `unicodedata.decimal` for
 * every `Nd` code point.
 */
export function decimalDigitValue(codePoint: number): number | null {
  if (codePoint >= 0x30 && codePoint <= 0x39) return codePoint - 0x30
  if (!isDecimalDigit(codePoint)) return null
  let zero = codePoint
  while (isDecimalDigit(zero - 1)) zero -= 1
  return (codePoint - zero) % 10
}

interface Digit {
  value: string
  width: number
}

/** The ASCII digit for the decimal digit at `index`, and how many UTF-16 units it takes. */
function digitAt(text: string, index: number): Digit | null {
  if (index >= text.length) return null
  const codePoint = text.codePointAt(index) ?? 0
  const value = decimalDigitValue(codePoint)
  return value === null ? null : { value: String(value), width: codePoint > 0xffff ? 2 : 1 }
}

/** `count` digits from `index` on, as ASCII, and where they end; `null` unless every one is a digit. */
function digitsAt(
  text: string,
  index: number,
  count: number
): { digits: string; end: number } | null {
  let digits = ''
  let cursor = index
  for (let i = 0; i < count; i += 1) {
    const digit = digitAt(text, cursor)
    if (!digit) return null
    digits += digit.value
    cursor += digit.width
  }
  return { digits, end: cursor }
}

function asciiDigits(text: string): string {
  return digitsAt(text, 0, Array.from(text).length)?.digits ?? ''
}

/** `index` moved past one separator: a run of whitespace, or one of `marks`. */
function skipSeparator(text: string, index: number, marks: string): number {
  let cursor = index
  if (cursor < text.length && isWhitespace(text[cursor])) {
    while (cursor < text.length && isWhitespace(text[cursor])) cursor += 1
  } else if (cursor < text.length && marks.includes(text[cursor])) {
    cursor += 1
  }
  return cursor
}

function splitWords(text: string): string[] {
  return text.split(SPACE_RUN).filter(Boolean)
}

// --------------------------------------------------------------- reading

/**
 * Characters that print as nothing and sit inside words in extracted text: the
 * soft hyphen, the zero-width space, non-joiner and joiner, the word joiner and
 * the byte-order mark. A reading leaves them out.
 */
export const SCREENING_IGNORABLE = '\u00ad\u200b\u200c\u200d\u2060\ufeff'
/** Hyphens a line may be broken at; with a letter or digit on both sides of the break they are not part of the text. */
const BREAK_HYPHENS = '-\u2010\u2011'
const LINE_BREAKS = '\n\v\f\r\x85\u2028\u2029'
/** Whitespace that keeps a line. */
const HORIZONTAL_SPACE = [...SCREENING_WHITESPACE].filter((char) => !LINE_BREAKS.includes(char)).join('')

/** The text as a person reads it, and for each of its UTF-16 units where it stands in the original. */
interface Reading {
  text: string
  starts: number[]
  ends: number[]
}

/** `index` moved past one line break (`\r\n` is one); unchanged when none stands there. */
function lineBreakAt(text: string, index: number): number {
  if (text.startsWith('\r\n', index)) return index + 2
  return index < text.length && LINE_BREAKS.includes(text[index]) ? index + 1 : index
}

/**
 * Where a hyphen at `index` that breaks a word across lines ends, counting the
 * break; `index` when it is none. `Gehalts-` + line break + `abrechnung` and
 * `05-` + line break + `32` are one word and one number. One line break only: a
 * blank line is a paragraph, and a hyphen with a space before it is a dash.
 */
function hyphenationEnd(text: string, index: number): number {
  if (!BREAK_HYPHENS.includes(text[index]) || !wordCharBefore(text, index)) return index
  let cursor = index + 1
  while (cursor < text.length && HORIZONTAL_SPACE.includes(text[cursor])) cursor += 1
  let broken = lineBreakAt(text, cursor)
  if (broken === cursor) return index
  while (broken < text.length && HORIZONTAL_SPACE.includes(text[broken])) broken += 1
  return broken < text.length && wordCharAt(text, broken) ? broken : index
}

/** `text` without invisible characters and hyphenation breaks; every rule runs on this. */
function read(text: string): Reading {
  const chars: string[] = []
  const starts: number[] = []
  const ends: number[] = []
  let index = 0
  while (index < text.length) {
    const skipped = hyphenationEnd(text, index)
    if (SCREENING_IGNORABLE.includes(text[index])) {
      index += 1
    } else if (skipped > index) {
      index = skipped
    } else {
      chars.push(text[index])
      starts.push(index)
      ends.push(index + 1)
      index += 1
    }
  }
  return { text: chars.join(''), starts, ends }
}

// ------------------------------------------------------------------ fold

/** `[start, end)` of each character with the combining marks that follow it. */
function clusters(text: string): Array<[number, number]> {
  const out: Array<[number, number]> = []
  let index = 0
  for (const char of text) {
    const last = out[out.length - 1]
    if (last && MARK.test(char)) last[1] = index + char.length
    else out.push([index, index + char.length])
    index += char.length
  }
  return out
}

function foldCluster(cluster: string): string {
  return foldForScreening(cluster).replace(FINAL_SIGMA, 'σ')
}

/** The fold both a term and the text are compared in, built per cluster. */
export function foldContent(text: string): string {
  return clusters(text)
    .map(([start, end]) => foldCluster(text.slice(start, end)))
    .join('')
}

interface Folded {
  text: string
  starts: number[]
  ends: number[]
}

function foldMapped(text: string): Folded {
  const parts: string[] = []
  const starts: number[] = []
  const ends: number[] = []
  for (const [start, end] of clusters(text)) {
    const folded = foldCluster(text.slice(start, end))
    parts.push(folded)
    for (let i = 0; i < folded.length; i += 1) {
      starts.push(start)
      ends.push(end)
    }
  }
  return { text: parts.join(''), starts, ends }
}

function escapeRegExp(text: string): string {
  // No `-`: outside a class, `\-` is an invalid escape under the `u` flag.
  return text.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')
}

function termPattern(term: string): string[] {
  return splitWords(foldContent(term))
}

/** Whether folded `index` begins a cluster that no letter or digit precedes in the text the rules read. */
function startsAWord(folded: Folded, text: string, index: number): boolean {
  if (index === 0) return true
  const previous = folded.starts[index - 1]
  return previous !== folded.starts[index] && !wordCharAt(text, previous)
}

/** Where the words end when they stand at `start` with whitespace between them; -1 when they do not. */
function matchWordsAt(text: string, start: number, words: readonly string[]): number {
  let cursor = start
  for (let w = 0; w < words.length; w += 1) {
    if (w > 0) {
      const gap = cursor
      while (cursor < text.length && isWhitespace(text[cursor])) cursor += 1
      if (cursor === gap) return -1
    }
    if (!text.startsWith(words[w], cursor)) return -1
    cursor += words[w].length
  }
  return cursor
}

/**
 * `[start, end)` of each match of a term's words in folded text, leftmost
 * first and not overlapping. Done without a regex built from office input, so
 * no term can be read as a pattern (Semgrep `detect-non-literal-regexp`, the
 * precedent in `features/layout/lib/file-reference-markers.ts`).
 */
function* termMatches(
  folded: Folded,
  text: string,
  words: readonly string[]
): Generator<[number, number]> {
  if (words.length === 0) return
  let index = folded.text.indexOf(words[0])
  while (index !== -1) {
    const end = startsAWord(folded, text, index) ? matchWordsAt(folded.text, index, words) : -1
    if (end > index) {
      yield [index, end]
      index = folded.text.indexOf(words[0], end)
    } else {
      index = folded.text.indexOf(words[0], index + 1)
    }
  }
}

// ----------------------------------------------------------------- rules

function codePointLength(text: string): number {
  return Array.from(text).length
}

/** Stripped, in bounds, first spelling of each folded form kept, at most 200. */
function normalisedTerms(terms: readonly string[]): string[] {
  const kept = new Map<string, string>()
  for (const term of terms) {
    const stripped = splitWords(term).join(' ')
    const length = codePointLength(stripped)
    if (length < MIN_TERM_CHARS || length > MAX_TERM_CHARS) continue
    const key = foldContent(stripped)
    if (!kept.has(key)) kept.set(key, stripped)
  }
  return [...kept.values()].slice(0, MAX_TERMS)
}

/** Rules from terms and detector names, normalised; `null` when nothing is left to check. */
export function buildContentRules(
  terms: readonly string[],
  detectors: readonly string[]
): ContentScreenRules | null {
  const keptTerms = normalisedTerms(terms)
  const wanted = new Set(detectors)
  const keptDetectors = SCREENING_DETECTORS.filter((name) => wanted.has(name))
  if (keptTerms.length === 0 && keptDetectors.length === 0) return null
  return { terms: keptTerms, detectors: keptDetectors, patterns: keptTerms.map(termPattern) }
}

/**
 * What a chat message is screened with: the policy's CONTENT terms and its
 * detectors. Never the name terms, which are for file and folder names and far
 * too broad for prose. `null` when the office switched screening off.
 */
export function chatScreeningRules(policy: UploadScreeningPolicy): ContentScreenRules | null {
  if (!policy.enabled) return null
  return buildContentRules(policy.contentTerms, policy.detectors)
}

// ------------------------------------------------------------- detectors

/**
 * Every country that issues IBANs, and the one length its IBANs have: the SWIFT
 * registry plus the countries that issue IBANs outside it, as Python's
 * `content_screen.IBAN_LENGTHS` lists them (the shared fixture holds both to
 * the same table). A country not listed issues no IBAN.
 */
// prettier-ignore
export const IBAN_LENGTHS: ReadonlyMap<string, number> = new Map(
  Object.entries({
    AD: 24, AE: 23, AL: 28, AO: 25, AT: 20, AX: 18, AZ: 28, BA: 20, BE: 16, BF: 28,
    BG: 22, BH: 22, BI: 27, BJ: 28, BL: 27, BR: 29, BY: 28, CF: 27, CG: 27, CH: 21,
    CI: 28, CM: 27, CR: 22, CV: 25, CY: 28, CZ: 24, DE: 22, DJ: 27, DK: 18, DO: 28,
    DZ: 26, EE: 20, EG: 29, ES: 24, FI: 18, FK: 18, FO: 18, FR: 27, GA: 27, GB: 22,
    GE: 22, GF: 27, GG: 22, GI: 23, GL: 18, GP: 27, GQ: 27, GR: 27, GT: 28, GW: 25,
    HN: 28, HR: 21, HU: 28, IE: 22, IL: 23, IM: 22, IQ: 23, IR: 26, IS: 26, IT: 27,
    JE: 22, JO: 30, KM: 27, KW: 30, KZ: 20, LB: 28, LC: 32, LI: 21, LT: 20, LU: 20,
    LV: 21, LY: 25, MA: 28, MC: 27, MD: 24, ME: 22, MF: 27, MG: 27, MK: 19, ML: 28,
    MN: 20, MQ: 27, MR: 27, MT: 31, MU: 30, MZ: 25, NC: 27, NE: 28, NI: 28, NL: 18,
    NO: 15, OM: 23, PF: 27, PK: 24, PL: 28, PM: 27, PS: 29, PT: 25, QA: 29, RE: 27,
    RO: 24, RS: 22, RU: 33, SA: 24, SC: 31, SD: 18, SE: 24, SI: 19, SK: 24, SM: 27,
    SN: 28, SO: 23, ST: 25, SV: 28, TD: 27, TF: 27, TG: 28, TL: 23, TN: 24, TR: 26,
    UA: 29, VA: 22, VG: 24, WF: 27, XK: 20, YE: 30, YT: 27,
  })
)

/**
 * Where an IBAN may start: an ASCII letter followed by one, not right after a
 * digit. A label may stand against it (`IBAN:AT61`, `SWIFTAT61`): the country
 * fixes the length and the check digits decide, so the boundary adds no
 * precision. The parse is `ibanAt`.
 */
const IBAN_START = /(?<!\p{Nd})[A-Za-z](?=[A-Za-z])/gu
/** Where a social-security number may start: a digit not right after another. */
const SVNR_START = /(?<!\p{Nd})\p{Nd}/gu
const SVNR_WEIGHTS = [3, 7, 9, 0, 5, 8, 4, 2, 1, 6]
const SVNR_MARKS = '-./'
/**
 * A maximal run of digit groups joined by spaces (never a tab: that is a table
 * cell), one `-` or `.`: where a card may be printed.
 */
const CARD_RUN = /\p{Nd}(?:(?:[ \xa0\u1680\u2000-\u200a\u202f\u205f\u3000]+|[-.])?\p{Nd})*/gu
const DIGIT_GROUP = /\p{Nd}+/gu
/** Layouts a card is printed in besides 4-4-4-4 and one unbroken number. */
const CARD_SPLITS = ['4,6,5', '4,6,4']
const CARD_MAX_GROUPS = 5
const IBAN_CHARS = /^[0-9A-Za-z]+$/

export function validIban(compact: string): boolean {
  if (IBAN_LENGTHS.get(compact.slice(0, 2)) !== compact.length || !IBAN_CHARS.test(compact))
    return false
  let remainder = 0
  for (const char of compact.slice(4) + compact.slice(0, 4)) {
    for (const digit of String(parseInt(char, 36)))
      remainder = (remainder * 10 + Number(digit)) % 97
  }
  return remainder === 1
}

/** The IBAN character at `index`: a digit as ASCII, or (past the check digits) an ASCII letter upper-cased. */
function ibanChar(text: string, index: number, digitsOnly: boolean): Digit | null {
  const digit = digitAt(text, index)
  if (digit || digitsOnly || index >= text.length) return digit
  const char = text[index]
  return ASCII_LETTER.test(char) ? { value: char.toUpperCase(), width: 1 } : null
}

/**
 * The IBAN printed at `start`: its compact form and where it ends. The country
 * fixes the length, so the parse reads exactly that many characters and stops;
 * a separator may stand after the country code and before each group of four.
 */
function ibanAt(text: string, start: number): { compact: string; end: number } | null {
  const country = text.slice(start, start + 2).toUpperCase()
  const length = IBAN_LENGTHS.get(country)
  if (length === undefined) return null
  let compact = country
  let index = start + 2
  for (let position = 2; position < length; position += 1) {
    if (position === 2 || position % 4 === 0) index = skipSeparator(text, index, '-.')
    const char = ibanChar(text, index, position < 4)
    if (!char) return null
    compact += char.value
    index += char.width
  }
  if (digitAt(text, index) || !validIban(compact)) return null
  return { compact, end: index }
}

function maskIban(compact: string): string {
  const hidden = Math.ceil(Math.max(compact.length - 8, 0) / 4)
  return [compact.slice(0, 4), ...Array<string>(hidden).fill(MASK), compact.slice(-4)].join(' ')
}

export function validAtSvnr(digits: string): boolean {
  if (!/^[0-9]{10}$/.test(digits) || digits[0] === '0') return false
  let sum = 0
  for (let i = 0; i < 10; i += 1) sum += Number(digits[i]) * SVNR_WEIGHTS[i]
  const check = sum % 11
  if (check === 10 || check !== Number(digits[3])) return false
  const day = Number(digits.slice(4, 6))
  const month = Number(digits.slice(6, 8))
  return day >= 1 && day <= 31 && month >= 1 && month <= 15
}

/**
 * The social-security number printed at `start`: `SSSS DDMMYY`, with or without
 * a separator after the serial; the date's own parts are either all joined
 * (`010180`) or all separated (`01 01 80`, `01.01.80`).
 */
function svnrAt(text: string, start: number): { digits: string; end: number } | null {
  const serial = digitsAt(text, start, 4)
  if (!serial) return null
  const day = digitsAt(text, skipSeparator(text, serial.end, SVNR_MARKS), 2)
  if (!day) return null
  const monthAt = skipSeparator(text, day.end, SVNR_MARKS)
  const split = monthAt !== day.end
  const month = digitsAt(text, monthAt, 2)
  if (!month) return null
  const yearAt = split ? skipSeparator(text, month.end, SVNR_MARKS) : month.end
  if (split && yearAt === month.end) return null
  const year = digitsAt(text, yearAt, 2)
  if (!year || digitAt(text, year.end)) return null
  const digits = serial.digits + day.digits + month.digits + year.digits
  return validAtSvnr(digits) ? { digits, end: year.end } : null
}

export function luhnValid(digits: string): boolean {
  let total = 0
  const reversed = [...digits].reverse()
  for (let index = 0; index < reversed.length; index += 1) {
    const value = Number(reversed[index]) * (index % 2 ? 2 : 1)
    total += value > 9 ? value - 9 : value
  }
  return total % 10 === 0
}

function validCard(digits: string): boolean {
  return (
    digits.length >= 13 && digits.length <= 19 && '23456'.includes(digits[0]) && luhnValid(digits)
  )
}

/** Whether groups of these sizes are how a card number is printed: unbroken, 4-4-4-4 (the last group 1-4), 4-6-5 or 4-6-4. */
function cardLayout(sizes: readonly number[]): boolean {
  if (sizes.length === 1) return sizes[0] >= 13 && sizes[0] <= 19
  if (CARD_SPLITS.includes(sizes.join(','))) return true
  const last = sizes[sizes.length - 1]
  return (
    sizes.length >= 4 &&
    sizes.slice(0, -1).every((size) => size === 4) &&
    last >= 1 &&
    last <= 4 &&
    sizes.reduce((sum, size) => sum + size, 0) <= 19
  )
}

/** Whether the groups `first` to `last` are not cut out of a longer number printed in fours. */
function standsAlone(groups: readonly string[], first: number, last: number): boolean {
  const before = first === 0 || groups[first - 1].length !== 4
  const after = last === groups.length || groups[last].length !== 4 || last === groups.length - 1
  return before && after
}

/**
 * Each card printed in a run of digit groups: its digits and where it starts
 * and ends in the run. A card is some consecutive groups that have a card's
 * layout and pass its checksum; the leftmost start wins and takes the longest
 * such stretch. What stands before it (a position) or after it (an expiry, a
 * security code) is not part of it. A group of four digits beside it is, though:
 * it makes the card a piece of a longer number printed in fours, which is judged
 * as a whole, so a table of years gets no sliding window. The last group may be
 * four digits long: it is the security code.
 */
function* cardsIn(run: string): Generator<{ digits: string; start: number; end: number }> {
  const matches = [...run.matchAll(DIGIT_GROUP)]
  const groups = matches.map((match) => asciiDigits(match[0]))
  let first = 0
  while (first < groups.length) {
    for (let last = Math.min(groups.length, first + CARD_MAX_GROUPS); last > first; last -= 1) {
      const digits = groups.slice(first, last).join('')
      const sizes = groups.slice(first, last).map((group) => group.length)
      if (cardLayout(sizes) && standsAlone(groups, first, last) && validCard(digits)) {
        const end = matches[last - 1]
        yield { digits, start: matches[first].index, end: end.index + end[0].length }
        first = last - 1
        break
      }
    }
    first += 1
  }
}

/** Every IBAN, in one pass: each start is parsed on its own, and the scan resumes after a match. */
function* ibanSpans(text: string): Generator<ContentSpan> {
  let resume = 0
  for (const match of text.matchAll(IBAN_START)) {
    if (match.index < resume) continue
    const found = ibanAt(text, match.index)
    if (!found) continue
    resume = found.end
    yield { kind: 'iban', start: match.index, end: found.end, sample: maskIban(found.compact) }
  }
}

function* svnrSpans(text: string): Generator<ContentSpan> {
  let resume = 0
  for (const match of text.matchAll(SVNR_START)) {
    if (match.index < resume) continue
    const found = svnrAt(text, match.index)
    if (!found) continue
    resume = found.end
    yield {
      kind: 'at_svnr',
      start: match.index,
      end: found.end,
      sample: `${MASK} ${MASK}${found.digits.slice(-2)}`,
    }
  }
}

function* cardSpans(text: string): Generator<ContentSpan> {
  for (const match of text.matchAll(CARD_RUN)) {
    for (const card of cardsIn(match[0])) {
      yield {
        kind: 'credit_card',
        start: match.index + card.start,
        end: match.index + card.end,
        sample: `${MASK} ${card.digits.slice(-4)}`,
      }
    }
  }
}

const DETECTOR_SPANS: Readonly<Record<ScreeningDetector, (text: string) => Iterable<ContentSpan>>> =
  {
    iban: ibanSpans,
    at_svnr: svnrSpans,
    credit_card: cardSpans,
  }

// ----------------------------------------------------------------- spans

/** `end` moved over the rest of the word it is in: letters, digits and their combining marks. */
function wordEnd(text: string, end: number): number {
  let cursor = end
  while (cursor < text.length) {
    const char = codePointAt(text, cursor)
    if (!WORD_CHAR.test(char)) break
    cursor += char.length
  }
  return cursor
}

function* termSpans(text: string, rules: ContentScreenRules): Generator<ContentSpan> {
  const folded = foldMapped(text)
  for (let i = 0; i < rules.terms.length; i += 1) {
    for (const [matchStart, matchEnd] of termMatches(folded, text, rules.patterns[i])) {
      const start = folded.starts[matchStart]
      const end = wordEnd(text, folded.ends[matchEnd - 1])
      yield { kind: 'term', start, end, term: rules.terms[i] }
    }
  }
}

const PLACEHOLDER_RE = new RegExp(
  Object.values(SCREENING_PLACEHOLDERS).map(escapeRegExp).join('|'),
  'g'
)

/** `spans` without the card and social-security matches that lie inside an IBAN's own digits. */
function outsideIbans(spans: readonly ContentSpan[]): ContentSpan[] {
  const ibans = spans.filter((span) => span.kind === 'iban')
  return spans.filter(
    (span) =>
      (span.kind !== 'at_svnr' && span.kind !== 'credit_card') ||
      !ibans.some((iban) => iban.start <= span.start && span.end <= iban.end)
  )
}

/**
 * Every match of every rule: terms in the rules' order, then the detectors,
 * each by position. The rules read the text as a person does (`read`), and each
 * span is given back in the ORIGINAL text. Overlapping matches are all kept,
 * except that digits inside a recognised IBAN are not also a card or a
 * social-security number; a match overlapping a placeholder is dropped.
 */
export function findSpans(text: string, rules: ContentScreenRules): ContentSpan[] {
  if (!text) return []
  const protectedRegions = [...text.matchAll(PLACEHOLDER_RE)].map(
    (match) => [match.index, match.index + match[0].length] as const
  )
  const reading = read(text)
  const spans = [...termSpans(reading.text, rules)]
  for (const name of rules.detectors) spans.push(...DETECTOR_SPANS[name](reading.text))
  return outsideIbans(spans)
    .map((span) => ({ ...span, start: reading.starts[span.start], end: reading.ends[span.end - 1] }))
    .filter((span) => !protectedRegions.some(([start, end]) => span.start < end && start < span.end))
}

// --------------------------------------------------------------- masking

function merged(spans: readonly ContentSpan[]): ContentSpan[] {
  const out: ContentSpan[] = []
  const ordered = [...spans].sort((a, b) => a.start - b.start || b.end - a.end)
  for (const span of ordered) {
    const last = out[out.length - 1]
    if (last && span.start < last.end)
      out[out.length - 1] = { ...last, end: Math.max(last.end, span.end) }
    else out.push(span)
  }
  return out
}

function replaced(text: string, spans: readonly ContentSpan[]): string {
  let out = ''
  let cursor = 0
  for (const span of merged(spans)) {
    out += text.slice(cursor, span.start) + SCREENING_PLACEHOLDERS[span.kind]
    cursor = span.end
  }
  return out + text.slice(cursor)
}

function findingsOf(spans: readonly ContentSpan[], rules: ContentScreenRules): ContentFinding[] {
  const order: Array<{ kind: ContentScreenKind; term?: string }> = [
    ...rules.terms.map((term) => ({ kind: 'term' as const, term })),
    ...rules.detectors.map((kind) => ({ kind })),
  ]
  const findings: ContentFinding[] = []
  for (const rule of order) {
    const matched = spans.filter((span) => span.kind === rule.kind && span.term === rule.term)
    if (matched.length === 0) continue
    const finding: ContentFinding = { kind: rule.kind, count: matched.length }
    if (rule.term !== undefined) finding.term = rule.term
    if (matched[0].sample !== undefined) finding.sample = matched[0].sample
    findings.push(finding)
  }
  return findings
}

/**
 * `text` with every term and detector match replaced by its placeholder, and
 * what was found. `null` rules mask nothing. Idempotent: masking the result
 * again returns it unchanged with no findings, because the loop runs until a
 * pass finds nothing (no pass limit that could leave a match behind). It ends:
 * each pass turns at least one character outside a placeholder into a
 * placeholder, and placeholders never overlap, so the characters outside them
 * strictly decrease.
 */
export function maskText(text: string, rules: ContentScreenRules | null): MaskedText {
  if (!rules || !text) return { text, findings: [] }
  const found: ContentSpan[] = []
  let current = text
  let spans = findSpans(current, rules)
  while (spans.length > 0) {
    found.push(...spans)
    current = replaced(current, spans)
    spans = findSpans(current, rules)
  }
  return { text: current, findings: findingsOf(found, rules) }
}
