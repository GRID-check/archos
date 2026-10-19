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

/** The longest tail worth keeping: past this, the head has no room left to be the part that shrinks. */
export const MAX_TAIL_LENGTH = 28

const SEPARATORS = new Set(['_', '-', ' ', '.', '(', '['])

/** How far the cut may move back (the tail grows) to reach a word's start. */
const SNAP_BACK = 6

/** Whether a cut before `chars[at]` falls between two words rather than inside one. */
const atBoundary = (chars: readonly string[], at: number): boolean =>
  SEPARATORS.has(chars[at - 1] ?? '') || SEPARATORS.has(chars[at] ?? '')

/**
 * Move a cut onto the nearest word boundary: back first, by up to
 * {@link SNAP_BACK} characters, so the tail keeps a little more; else forward,
 * by up to half the tail, so it keeps a little less but starts on a word. A
 * name with no separator near the cut keeps the cut where it was.
 */
function snapToBoundary(chars: readonly string[], cut: number, keep: number): number {
  for (let at = cut; at >= Math.max(1, cut - SNAP_BACK); at -= 1) if (atBoundary(chars, at)) return at
  const forward = Math.floor(keep / 2)
  for (let at = cut + 1; at <= Math.min(chars.length - 1, cut + forward); at += 1) if (atBoundary(chars, at)) return at
  return cut
}

/**
 * Split `text` into a shrinkable head and a tail of about `tailLength`
 * characters.
 *
 * The cut lands between words where there is a separator near it, because the
 * tail is what the reader sees whole after the ellipsis: `Grundri` + `ss_1OG_C.pdf`
 * read as „Grun… ss_1OG_C.pdf", a fragment of a word that is no word, where
 * `Grundriss` + `_1OG_C.pdf` reads as „Grundr…_1OG_C.pdf".
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
  const cut = snapToBoundary(chars, chars.length - keep, keep)
  if (cut <= 3) return { head: '', tail: text }
  return {
    head: chars.slice(0, cut).join(''),
    tail: chars.slice(cut).join(''),
  }
}

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
