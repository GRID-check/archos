/**
 * Words that must not be parted across a line: „38 m", „§ 108", „REI 90",
 * „2. Obergeschoß".
 *
 * German building law is full of them, and on a phone column of ~30 characters
 * they are what breaks a line in the worst place: a value on one line and its
 * unit on the next („zulässig sind 40 / m von jeder Stelle"), a „§" stranded at
 * the end of a line with its number under it, „R / 60". Each is a unit of
 * meaning the reader has to put back together, and in a sentence a figure is
 * what they came for.
 *
 * Done on the text the reader sees and nowhere else: a no-break space (U+00A0)
 * in place of the ordinary one, in running prose only. Tables, lists, code and
 * math keep their own text, because the answer's data blocks read quantities
 * back off that text, and a paragraph's own words are the only place a line
 * break is a typographic decision.
 *
 * Pure, so it is testable without a renderer; `rehypeBindWords` is the pass.
 */

import type { Element, Root, RootContent } from 'hast'

const NBSP = ' '

/** Units a figure takes: lengths, areas, volumes, loads, sound, per cent. A bare `s` or `h` is left alone: too many words end that way. */
const UNIT = String.raw`(?:m²|m³|m|cm|mm|km|kN|kg|kW|dB|Pa|%|°C|min|Min\.|Std\.|l)`
/** What follows a unit for it to be a unit and not the front of a word. */
const AFTER = String.raw`(?=[\s.,;:)!? ]|$)`
/** Abbreviations and short labels that stand before a number, and so keep it with them. */
const LABEL = String.raw`(?:Abs\.|Art\.|Z\.|Nr\.|lit\.|Tab\.|Tabelle|Kap\.|Anh\.|Anhang|Punkt|Seite|S\.|GK|REI|RE|EI|R|F|OIB-RL)`
/** A number's ordinal before the storey, and the storeys. */
const ORDINAL = String.raw`(?:OG|Obergeschoß|Obergeschoss|Stock|Geschoß|Geschoss|UG|Untergeschoß|Absatz)`

const RULES: [RegExp, string][] = [
  // 38 m, 1.200 m², 62 %, 20 °C
  [new RegExp(String.raw`(\d) (?=${UNIT}${AFTER})`, 'g'), `$1${NBSP}`],
  // § 108, §§ 12
  [/(§§?) (?=\d)/g, `$1${NBSP}`],
  // Abs. 2, Tabelle 1b, REI 90, S. 12
  [new RegExp(String.raw`(^|[\s( ])(${LABEL}) (?=\d)`, 'g'), `$1$2${NBSP}`],
  // 2. Obergeschoß
  [new RegExp(String.raw`(\d\.) (?=${ORDINAL}${AFTER})`, 'g'), `$1${NBSP}`],
]

/** `text` with the spaces inside its units of meaning made unbreakable. */
export const bindWords = (text: string): string => RULES.reduce((out, [pattern, to]) => out.replace(pattern, to), text)

/** Elements whose text is data or code, never prose to be broken: left exactly as written. */
const KEEP = new Set(['code', 'pre', 'table', 'ul', 'ol', 'a', 'button', 'svg', 'math'])

const bindIn = (node: Element | Root, inProse: boolean): void => {
  for (const child of node.children as RootContent[]) {
    if (child.type === 'text') {
      if (inProse) child.value = bindWords(child.value)
      continue
    }
    if (child.type !== 'element') continue
    if (KEEP.has(child.tagName)) continue
    const classes = child.properties?.className
    if (Array.isArray(classes) && classes.some((name) => String(name).startsWith('katex'))) continue
    bindIn(child, inProse || child.tagName === 'p')
  }
}

/** The rehype pass: binds the words of every paragraph, and only a paragraph's. */
export const rehypeBindWords = () => (tree: Root): void => bindIn(tree, false)
