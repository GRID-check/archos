/**
 * Excalidraw's exported SVG, made into one this product can file.
 *
 * `exportToSvg` returns a self-contained drawing, and three things in it are
 * refused by the server's validator (`lib/diagrams/svg.ts`) or cannot reach
 * the PDF:
 *
 *   - `<style>`: the inlined `@font-face` of Excalidraw's webfonts. Asked off
 *     at the source (`skipInliningFonts`), removed here when a release emits
 *     an empty one anyway. Every label on the canvas is Helvetica
 *     (`SKETCH_FONT_FAMILY`), which the preview and `@react-pdf/renderer` both
 *     have, so nothing the person saw depends on it.
 *   - `<mask>`: Excalidraw cuts an arrow's line where its label sits. A mask
 *     is an effect, not geometry (the same line `render-diagram.ts` draws for
 *     a filter): removed, the line runs under the label, and every stroke and
 *     word is still there.
 *   - `<image>` and `<foreignObject>`: an embedded picture or an embed. The
 *     editor turns both tools off, so a scene with one was not made there;
 *     these stay and the validator refuses them by name, which is right for
 *     a file that would otherwise arrive with part of its picture missing.
 *
 * Then the bytes go through the server's own parser and serialiser, in the
 * browser, exactly as a mermaid render does: what the person is told was filed
 * is what the allow-list wrote, and a refusal surfaces here, named, instead of
 * as a 400 on their finished sketch.
 */

import { parseDiagramSvg, serializeDiagramSvg } from './svg'

/** Elements removed by the producer because they carry no geometry the file needs. */
const SKETCH_EFFECTS = ['style', 'mask'] as const

export function fileableSketchSvg(svg: SVGSVGElement): string {
  const root = svg.cloneNode(true) as SVGSVGElement
  for (const name of SKETCH_EFFECTS) {
    for (const element of Array.from(root.querySelectorAll(name))) element.remove()
  }
  for (const element of Array.from(root.querySelectorAll('[mask]'))) element.removeAttribute('mask')
  const serialized = new XMLSerializer().serializeToString(root)
  return serializeDiagramSvg(parseDiagramSvg(serialized).root)
}
