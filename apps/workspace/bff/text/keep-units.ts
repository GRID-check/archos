/**
 * A figure and its unit never part at a line end: „42,10 m“, „40 m²“, „30 %“.
 *
 * The space between them becomes a no-break space, as German typesetting asks
 * (DIN 5008), so a narrow column wraps before the figure instead of leaving
 * „m“ alone at the start of the next line.
 */

const NO_BREAK_SPACE = '\u00A0'

/** Units a building's figures carry, longest first so „m²“ is not read as „m“. None is a regex metacharacter. */
const UNITS = ['m²', 'm³', 'cm', 'mm', 'km', 'kg', 'kN', 'kW', 'dB', '°C', 'm', 't', '%', '‰', '°']

const FIGURE_AND_UNIT = new RegExp(`(\\d) (?=(?:${UNITS.join('|')})(?![\\p{L}\\p{N}]))`, 'gu')

export function keepUnitsTogether(text: string): string {
  return text.replace(FIGURE_AND_UNIT, `$1${NO_BREAK_SPACE}`)
}
