/**
 * The font files the sketch renderer measures with, read only when a
 * character needs them (ADR-0149).
 *
 * A woff2 has to be decompressed whole before fontkit can say which characters
 * it has, and Excalidraw ships 209 Xiaolai chunks (13 MB) behind its
 * hand-drawn font: decoding them all on the first `²` cost 600 ms. So the
 * build writes each file's coverage once (`font-coverage.json` beside the
 * bundle, {@link fontCoverage}), and a face is decoded on the first character
 * it is asked to set. Without the index every file of a folder is decoded when
 * the folder is first needed, which is correct and slower.
 */

import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { create as createFont, type Font } from 'fontkit'
import type { MetricsFont } from './sketch-text-metrics'

/** Per folder, per file: the code points it has, as inclusive `[first, last]` ranges. */
export type FontCoverage = Record<string, Record<string, [number, number][]>>

const FONT_FILE = /\.(woff2|ttf)$/

function fontFiles(dir: string): string[] {
  try {
    return readdirSync(dir).filter((file) => FONT_FILE.test(file)).sort()
  } catch {
    return []
  }
}

/** The ranges of a sorted set of code points. Pure. */
export function rangesOf(codePoints: readonly number[]): [number, number][] {
  const sorted = [...new Set(codePoints)].sort((a, b) => a - b)
  const ranges: [number, number][] = []
  for (const point of sorted) {
    const last = ranges.at(-1)
    if (last && point === last[1] + 1) last[1] = point
    else ranges.push([point, point])
  }
  return ranges
}

/** Every font file's coverage under `fontsDir`, by decoding each once (the build's step). */
export function fontCoverage(fontsDir: string): FontCoverage {
  const coverage: FontCoverage = {}
  for (const folder of readdirSync(fontsDir)) {
    const files: Record<string, [number, number][]> = {}
    for (const file of fontFiles(join(fontsDir, folder))) {
      try {
        files[file] = rangesOf(createFont(readFileSync(join(fontsDir, folder, file))).characterSet)
      } catch {
        // A file fontkit cannot read is one the renderer cannot measure with either.
      }
    }
    coverage[folder] = files
  }
  return coverage
}

function covers(ranges: readonly [number, number][], point: number): boolean {
  let low = 0
  let high = ranges.length - 1
  while (low <= high) {
    const middle = (low + high) >> 1
    const [first, last] = ranges[middle]
    if (point < first) high = middle - 1
    else if (point > last) low = middle + 1
    else return true
  }
  return false
}

/** A face that answers from the index and decodes its file when it first sets a character. */
function lazyFace(path: string, ranges: readonly [number, number][]): MetricsFont {
  let font: Font | null = null
  const decoded = () => (font ??= createFont(readFileSync(path)))
  return {
    get unitsPerEm() {
      return decoded().unitsPerEm
    },
    hasGlyphForCodePoint: (point) => covers(ranges, point),
    glyphForCodePoint: (point) => decoded().glyphForCodePoint(point),
    layout: (text) => decoded().layout(text),
  }
}

/** The faces of one folder, for `createTextMetrics`: lazy where the index knows the file, decoded now where it does not. */
export function facesFrom(fontsDir: string, coverage: FontCoverage | null): (folder: string) => MetricsFont[] {
  return (folder) =>
    fontFiles(join(fontsDir, folder)).flatMap((file) => {
      const path = join(fontsDir, folder, file)
      const ranges = coverage?.[folder]?.[file]
      if (ranges) return [lazyFace(path, ranges)]
      try {
        return [createFont(readFileSync(path))]
      } catch {
        return []
      }
    })
}
