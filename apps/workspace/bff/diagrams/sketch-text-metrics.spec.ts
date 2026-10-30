// @disk-inputs: public/excalidraw/fonts/**
/**
 * @vitest-environment node
 */
/**
 * The server's text widths against a browser's (ADR-0149): every string of the
 * fixture, measured by Chromium's canvas, within 0.05 px.
 */
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { create } from 'fontkit'
import { describe, expect, it } from 'vitest'
import fixture from './__fixtures__/sketch-text-widths.json'
import { createTextMetrics, parseFontString, type MetricsFont } from './sketch-text-metrics'

const FONTS = join(process.cwd(), 'public', 'excalidraw', 'fonts')

const facesOf = (folder: string): MetricsFont[] => {
  try {
    return readdirSync(join(FONTS, folder))
      .filter((file) => file.endsWith('.woff2'))
      .sort()
      .map((file) => create(readFileSync(join(FONTS, folder, file))))
  } catch {
    return []
  }
}

describe('createTextMetrics', () => {
  const metrics = createTextMetrics(facesOf)

  it('measures every fixture string as Chromium does', () => {
    const misses = fixture.widths
      .map((row) => ({ ...row, server: Number(metrics.lineWidth(row.text, row.font).toFixed(3)) }))
      .filter((row) => Math.abs(row.server - row.width) > 0.05)
    expect(misses).toEqual([])
  })

  it('kerns within a word and not across a space, as Chromium shapes words', () => {
    const font = '20px Helvetica, Segoe UI Emoji'
    // „AV“ kerns; „A V“ is the two letters and a space.
    expect(metrics.lineWidth('AV', font)).toBeLessThan(metrics.lineWidth('A', font) + metrics.lineWidth('V', font))
    expect(metrics.lineWidth(' A', font)).toBeCloseTo(metrics.lineWidth(' ', font) + metrics.lineWidth('A', font), 5)
  })

  it('falls back to Helvetica’s metrics for a family it has no file for', () => {
    expect(metrics.lineWidth('Küche', '20px Segoe UI Emoji')).toBeCloseTo(metrics.lineWidth('Küche', '20px Helvetica'), 5)
    expect(metrics.lineWidth('', '20px Helvetica')).toBe(0)
  })
})

describe('parseFontString', () => {
  it('reads Excalidraw’s font shorthand', () => {
    expect(parseFontString('20px Excalifont, Xiaolai, Segoe UI Emoji')).toEqual({ size: 20, families: ['Excalifont', 'Xiaolai', 'Segoe UI Emoji'] })
    expect(parseFontString('12.5px "Lilita One"')).toEqual({ size: 12.5, families: ['Lilita One'] })
  })
})
