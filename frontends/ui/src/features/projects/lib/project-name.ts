/**
 * How much of a project name to keep when it does not fit its line.
 *
 * Project names put the part that tells them apart at the END ("Hotel
 * Semmering — Neubau Gästetrakt" against "… — Sanierung Altbau"), which is the
 * part end-truncation throws away. The line is therefore cut in the middle
 * (`MiddleTruncate`), and the kept tail starts at a word: a tail of the last 16
 * characters reads "eubau Gästetrakt".
 */

const MAX_TAIL = 22
const MIN_TAIL = 8
const FALLBACK_TAIL = 14

/** Letters or digits: a tail that opens on a dash or bracket reads as debris. */
const STARTS_A_WORD = /^[\p{L}\p{N}]/u

export function projectNameTail(name: string): number {
  const chars = Array.from(name)
  let best = 0
  for (let index = chars.length - 1; index > 0; index -= 1) {
    const length = chars.length - index
    if (length > MAX_TAIL) break
    const startsWord = chars[index - 1] === ' ' && STARTS_A_WORD.test(chars[index] ?? '')
    if (startsWord && length >= MIN_TAIL) best = length
  }
  return best > 0 ? best : FALLBACK_TAIL
}
