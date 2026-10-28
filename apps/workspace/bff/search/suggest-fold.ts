/**
 * The form a typed start of a value and the stored values are compared in by
 * the search's completions (`POST /api/search/suggest`): lower case, accents
 * dropped one letter for one („Müller“ → „muller“, „Ö“ → „o“), „ß“ as „ss“,
 * and the marks that separate words in a name or a number („-“, „/“, „&“…)
 * as spaces, so „EP-0“ finds „EP 05“ and „statik“ the second word of
 * „Holz & Statik OG“. What `unaccent` would do, without an extension the
 * database does not have.
 *
 * Pure and browser-safe: the repository builds its SQL from the same strings
 * (`suggest-repository.ts`, one `translate()`), so the two sides cannot fold
 * apart.
 */

/** Letters folded, each to the letter at the same place in {@link FOLD_TO}. Upper case too: `lower()` under the C collation leaves them. */
const LETTERS_FROM = 'ÄÖÜäöüÁÀÂáàâÉÈÊéèêÍÌÎíìîÓÒÔóòôÚÙÛúùûÇçÑñŠšŽžČčĆćÝý'
const LETTERS_TO = 'aouaouaaaaaaeeeeeeiiiiiioooooouuuuuuccnnsszzccccyy'
/** Marks between words, each read as a space. */
const SEPARATORS = '-_/.,;:()[]&+|"\'„“”‚‘’'

export const FOLD_FROM = LETTERS_FROM + SEPARATORS
export const FOLD_TO = LETTERS_TO + ' '.repeat([...SEPARATORS].length)

const FOLD = new Map([...FOLD_FROM].map((char, index) => [char, FOLD_TO[index]]))

/** `value` in the form completions compare in: folded, its spaces collapsed, trimmed. */
export function foldForSuggest(value: string): string {
  let out = ''
  for (const char of value.normalize('NFC').toLowerCase()) out += FOLD.get(char) ?? char
  return out.replace(/ß/g, 'ss').replace(/\s+/g, ' ').trim()
}
