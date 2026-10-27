/**
 * The Planliste's column widths, from what the visible page holds.
 *
 * Fixed widths sized for the longest value any office might have cut the
 * words that tell two rows apart („Atelier Lindner ZT Gm…“, „Wohnhaus
 * Seestadt Ba…“) while the name column, given the rest, often had room to
 * spare. Each column now asks for the width its header needs (`min`) and the
 * width its longest value on the page needs (`want`); the room left after
 * every minimum goes first to the name, up to a line most names fit in, then
 * to each column in reading order up to its want, and whatever is still left
 * goes to the name again. Only when the minimums alone do not fit does the
 * table scroll sideways.
 *
 * Widths are estimated from character counts at the register's type sizes,
 * calibrated on the rendered table: no layout pass, no flicker, and a spec
 * can check them.
 */

/** One column's claim, in rem. `rest`: the name, which takes what is left. */
export interface ColumnFit {
  min: number
  want: number
  rest?: boolean
}

/** The narrowest the name column gets before the register scrolls sideways instead. */
export const NAME_MIN_REM = 12

/** How far the name is served before the other columns: most document names fit in it. */
const NAME_FIRST_REM = 18

/** Average advance per character, in rem, by how a cell sets its text. */
const ADVANCE = {
  /** The header: small caps-height uppercase, tracked. */
  header: 0.47,
  /** Running text at text-sm. */
  text: 0.45,
  /** The name, text-sm medium. */
  strong: 0.47,
  /** Plannummer, Index, Maßstab: mono at text-xs. */
  code: 0.45,
  /** A where-chip's label, text-xs medium. */
  mark: 0.43,
} as const

/** A cell's horizontal padding, and the slack that keeps a fitting value off the ellipsis. */
const CELL_PAD = 1.25
/** The header's padding, gap and sort arrow. */
const HEADER_EXTRA = 2
/** A chip's own padding, icon and gap. */
const MARK_EXTRA = 1.75

export type CellSetting = keyof typeof ADVANCE

/** The width a header needs to show its word and its sort arrow. */
export const headerRem = (label: string): number => round(label.length * ADVANCE.header + HEADER_EXTRA)

/** The width the longest of `values` needs in a cell set as `setting`. */
export function valuesRem(values: ReadonlyArray<string | null | undefined>, setting: Exclude<CellSetting, 'header'>): number {
  const longest = values.reduce<number>((most, value) => Math.max(most, value ? [...value].length : 0), 0)
  if (longest === 0) return 0
  return round(longest * ADVANCE[setting] + CELL_PAD + (setting === 'mark' ? MARK_EXTRA : 0))
}

const round = (rem: number): number => Math.ceil(rem * 4) / 4

/**
 * Each column's width in rem for `room` rem of table, `null` for the name.
 * Below the sum of the minimums the minimums are returned, and the caller
 * scrolls.
 */
export function fitColumns(columns: readonly ColumnFit[], room: number): Array<number | null> {
  const widths = columns.map((column) => Math.max(column.min, column.rest ? NAME_MIN_REM : 0))
  let left = room - widths.reduce((sum, width) => sum + width, 0)
  const grant = (index: number, upTo: number): void => {
    if (left <= 0) return
    const more = Math.min(left, Math.max(0, upTo - widths[index]!))
    widths[index]! += more
    left -= more
  }
  columns.forEach((column, index) => {
    if (column.rest) grant(index, Math.min(column.want, NAME_FIRST_REM))
  })
  columns.forEach((column, index) => {
    if (!column.rest) grant(index, column.want)
  })
  return columns.map((column, index) => (column.rest ? null : widths[index]!))
}

/** The table's least width: every minimum, the name's at least `NAME_MIN_REM`. */
export function minimumRem(columns: readonly ColumnFit[]): number {
  return columns.reduce((sum, column) => sum + Math.max(column.min, column.rest ? NAME_MIN_REM : 0), 0)
}

/**
 * A firm's name as the office says it: „Atelier Lindner ZT GmbH“ is
 * „Atelier Lindner“. Only a trailing legal form goes; the cell's tooltip keeps
 * the whole name.
 */
export function withoutLegalForm(name: string): string {
  const short = name.replace(/[\s,]+(?:ZT[\s-]+)?(?:GmbH(?:\s*&\s*Co\.?\s*KG)?|AG|KG|OG|e\.\s?U\.|GesbR|Ges\.m\.b\.H\.)$/u, '').trim()
  return short || name
}
