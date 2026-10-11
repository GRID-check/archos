/**
 * Where to cut a long name so the part that tells it apart survives.
 *
 * A drawing's file name carries what matters at its END: the index, the date,
 * the extension (`Wohnanlage-Schlosspark_Grundriss_1OG_Index-C.pdf`). End
 * truncation shows two Fassungen of that name as the same `Wohnanlage-Schloss…`,
 * so a name is cut in the MIDDLE instead: the head shrinks to whatever width
 * there is, the tail is kept whole.
 *
 * Only the split is decided here; the width is the browser's business (the
 * `MiddleTruncate` atom ellipsizes the head with CSS), because the same name
 * fits a wide dialog and not a phone.
 */

/** Characters kept at the end by default: enough for `_Index-C_v3.pdf`. */
export const DEFAULT_TAIL_LENGTH = 16

export interface MiddleSplit {
  /** The part that may be shortened with an ellipsis. Empty when nothing needs cutting. */
  head: string
  /** The part that is always shown. */
  tail: string
}

/**
 * Split `text` into a shrinkable head and a tail of about `tailLength`
 * characters.
 *
 * A name barely longer than its tail is not split at all (the whole of it is
 * the tail), since an ellipsis that hides two characters costs more than it
 * saves. The cut never lands inside a surrogate pair, so an emoji or a rare CJK
 * character in a name is not torn in half.
 */
export function splitForMiddleTruncation(text: string, tailLength = DEFAULT_TAIL_LENGTH): MiddleSplit {
  const keep = Math.max(1, Math.trunc(tailLength))
  const chars = Array.from(text)
  if (chars.length <= keep + 3) return { head: '', tail: text }
  return {
    head: chars.slice(0, chars.length - keep).join(''),
    tail: chars.slice(chars.length - keep).join(''),
  }
}

/** The longest tail worth keeping: past this, the head has no room left to be the part that shrinks. */
export const MAX_TAIL_LENGTH = 28

const SEPARATORS = new Set(['_', '-', ' ', '.', '(', '['])

/**
 * How much of `name`'s end to keep when it is shown next to `other`, so the
 * place where the two first differ is kept, starting at the word it falls in.
 *
 * Two Fassungen of one drawing share most of their name and differ in the
 * index: `…_1OG_Index_B_2026-09-14.pdf` against `…_1OG_Index_C_2026-10-02.pdf`.
 * A fixed tail of 16 keeps `B_2026-09-14.pdf` at best; this keeps
 * `Index_B_2026-09-14.pdf`. Never less than `min`, never more than `max`.
 */
export function distinguishingTailLength(
  name: string,
  other: string,
  { min = DEFAULT_TAIL_LENGTH, max = MAX_TAIL_LENGTH }: { min?: number; max?: number } = {},
): number {
  const a = Array.from(name)
  const b = Array.from(other)
  let common = 0
  while (common < a.length && common < b.length && a[common] === b[common]) common += 1
  if (common === a.length) return Math.min(min, a.length)
  // Back to the start of the word the difference falls in.
  let start = common
  while (start > 0 && !SEPARATORS.has(a[start - 1] ?? '')) start -= 1
  // And one word further back, so the label of the index („Index_") comes along.
  if (start > 0) {
    start -= 1
    while (start > 0 && !SEPARATORS.has(a[start - 1] ?? '')) start -= 1
  }
  return Math.max(min, Math.min(max, a.length - start))
}
