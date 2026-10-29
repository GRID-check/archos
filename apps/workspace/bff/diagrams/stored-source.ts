/**
 * Read a filed diagram's source back out of its stored bytes.
 *
 * `diagramSourceOf` (`svg.ts`) reads it from a parsed tree, and parsing the
 * stored file again is the wrong tool here: the validator caps an SVG at
 * `MAX_DIAGRAM_SVG_BYTES` (1 MiB), and a stored sketch is that picture PLUS its
 * scene of up to 512 KiB, so a large sketch the server filed would be refused
 * by its own parser on the way back.
 *
 * The stored bytes are the server's own writing, never a client's
 * (`serializeDiagramSvg`), so the one form to recognise is the one that writer
 * emits: `<metadata ATTRIBUTE="KIND">TEXT</metadata>` (`METADATA_KIND_ATTRIBUTE`) as a child
 * of the root, its text escaped by `escapeText` (`&`, `<`, `>`). That is why a
 * pattern is enough and why it is anchored to exactly that form: a file with
 * any other shape of metadata was not filed by this product and has no source
 * to offer.
 */

import { METADATA_KIND_ATTRIBUTE } from './svg'

const STORED_SOURCE = new RegExp(`<metadata ${METADATA_KIND_ATTRIBUTE}="([a-z]+)">([^<]*)</metadata>`)

/** `escapeText`'s inverse, plus the two attribute entities, which a text node never needs but may carry. */
function unescapeText(value: string): string {
  return value
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&')
}

/** The kind and source a stored diagram carries, or `null` when it carries none. */
export function storedDiagramSource(svg: string): { kind: string; source: string } | null {
  const match = STORED_SOURCE.exec(svg)
  if (!match) return null
  return { kind: match[1], source: unescapeText(match[2]) }
}
