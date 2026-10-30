/**
 * @vitest-environment node
 */
/**
 * A Skizze traced over a page, drawn and filed through the real worker (S6,
 * ADR-0150): Excalidraw places the page, the worker takes its stand-in out of
 * the picture, the filing writes the server's PNG into the slot, the PDF draws
 * the PNG from a Buffer, and a reader lifts the slot before the validator.
 */

import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createSketchRenderer, type SketchRenderer } from './sketch-renderer'
import { checkSketchScene } from './sketch-scene'
import { newUnderlayElement, type SketchUnderlay } from './sketch-underlay'
import { liftUnderlayImage, withUnderlayImage } from './sketch-underlay-svg'
import { whitePng } from './__fixtures__/white-png'
import { acceptDiagram, parseDiagramSvg } from './svg'
import { renderDiagramPdf } from './svg-to-pdf'

const fontsDir = join(process.cwd(), 'public', 'excalidraw', 'fonts')
const BASE: SketchUnderlay = { documentId: '22222222-2222-4222-8222-222222222222', versionId: '33333333-3333-4333-8333-333333333333', page: 1, dpi: 150 }
const page = newUnderlayElement('page', BASE, { widthPt: 1190.55, heightPt: 841.89 }, 11, { x: 40, y: 60 })
const room = { id: 'room', type: 'rectangle', x: 200, y: 200, width: 240, height: 140, angle: 0, strokeColor: '#1e1e1e', backgroundColor: 'transparent', fillStyle: 'solid', strokeWidth: 2, strokeStyle: 'solid', roughness: 1, opacity: 100, groupIds: [], frameId: null, index: 'a1', roundness: null, seed: 5, version: 1, versionNonce: 5, isDeleted: false, boundElements: null, updated: 1, link: null, locked: false }

let dir = ''
let renderer: SketchRenderer

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'sketch-underlay-'))
  execFileSync('bun', ['scripts/build-sketch-renderer.ts', '--outdir', dir], { cwd: process.cwd(), stdio: 'pipe' })
  renderer = createSketchRenderer({ workerPath: join(dir, 'sketch-render-worker.mjs'), fontsDir })
}, 120_000)

afterAll(async () => {
  await renderer?.close()
  if (dir) rmSync(dir, { recursive: true, force: true })
})

describe('a Skizze on a page', () => {
  it('is placed by Excalidraw and filed with the server’s PNG, never with the stand-in', async () => {
    const scene = checkSketchScene({ type: 'excalidraw', elements: [page, room] })
    const drawn = await renderer.render({ elements: scene.elements as unknown as Record<string, unknown>[], remeasure: [] })
    // Excalidraw's own place for it: the page's corner is the sheet's, inside the 16 px export padding.
    expect(drawn.underlay).toEqual({ x: 16, y: 16, width: 1191, height: 842 })
    expect(drawn.svg).not.toMatch(/<image|<use|<symbol|data:/)
    const accepted = acceptDiagram({ svg: drawn.svg, source: JSON.stringify(scene), sourceKind: 'excalidraw' }, { notice: 'Skizze — nicht maßstäblich', provenance: 'AIGenerated=true' })
    const png = whitePng(2481, 1754)
    const filed = withUnderlayImage(accepted.svg, { ...drawn.underlay!, png })
    const lifted = liftUnderlayImage(filed)
    expect(lifted.svg).toBe(accepted.svg)
    expect(() => parseDiagramSvg(lifted.svg)).not.toThrow()
    expect(filed).toContain('nicht maßstäblich')

    const pdf = await renderDiagramPdf({
      ...parseDiagramSvg(lifted.svg),
      underlay: lifted.underlay,
      title: 'Skizze',
      projectName: 'Projekt',
      marking: 'Skizze — nicht maßstäblich',
      provenance: 'AIGenerated=true' as never,
      createdAt: new Date(0),
    })
    const text = Buffer.from(pdf).toString('latin1')
    expect(text).toMatch(/\/Subtype\s*\/Image/)
    expect(text).not.toMatch(/https?:\/\/(?!www\.w3\.org)/)
  }, 30_000)

  it('keeps the background out, so the page is not painted over', async () => {
    const drawn = await renderer.render({ elements: [page, room], remeasure: [] })
    expect(drawn.svg).not.toMatch(/<rect x="0" y="0" width="1223"/)
  }, 30_000)
})
