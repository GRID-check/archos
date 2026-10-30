/**
 * @vitest-environment node
 */
/**
 * The server draws a sketch's picture (ADR-0149), through the real worker:
 * `scripts/build-sketch-renderer.ts` bundles it into a temporary folder (Bun is
 * the toolchain, ADR-0103), and the scene a browser exported
 * (`__fixtures__/sketch-scene.browser.svg`, Chromium, the editor's export
 * settings) is drawn again here and compared stroke by stroke.
 */

import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { acceptDiagram } from './svg'
import { createSketchRenderer, SketchRenderError, type SketchRenderer } from './sketch-renderer'
import { applySketchEdit } from './sketch-edit'
import { sketchEditDiffElements, DIFF_COLORS } from './sketch-edit-diff'
import { textsToMeasure } from './sketch-picture'
import { SKETCH_DOM_OPTIONS } from './sketch-render-dom'
import { checkSketchScene } from './sketch-scene'

const FIXTURES = join(process.cwd(), 'bff', 'diagrams', '__fixtures__')
const scene = JSON.parse(readFileSync(join(FIXTURES, 'sketch-scene.json'), 'utf8')) as Record<string, unknown>[]
const browser = readFileSync(join(FIXTURES, 'sketch-scene.browser.svg'), 'utf8')
const fontsDir = join(process.cwd(), 'public', 'excalidraw', 'fonts')
const { widths } = JSON.parse(readFileSync(join(FIXTURES, 'sketch-text-widths.json'), 'utf8')) as { widths: { font: string; text: string; width: number }[] }

const strokes = (svg: string) => [...svg.matchAll(/ d="([^"]+)"/g)].map((match) => match[1])
const words = (svg: string) => [...svg.matchAll(/<text[^>]*>([^<]*)<\/text>/g)].map((match) => match[1])

let dir = ''
let workerPath = ''
let renderer: SketchRenderer

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'sketch-renderer-'))
  execFileSync('bun', ['scripts/build-sketch-renderer.ts', '--outdir', dir], { cwd: process.cwd(), stdio: 'pipe' })
  workerPath = join(dir, 'sketch-render-worker.mjs')
  renderer = createSketchRenderer({ workerPath, fontsDir })
}, 120_000)

afterAll(async () => {
  await renderer?.close()
  if (dir) rmSync(dir, { recursive: true, force: true })
})

describe('the sketch renderer', () => {
  it('draws what the browser drew, and the filing validator takes it', async () => {
    const { svg, remeasured } = await renderer.render({ elements: scene, remeasure: [] })
    expect(strokes(svg).length).toBeGreaterThan(30)
    expect(strokes(svg)).toEqual(strokes(browser))
    expect(words(svg)).toEqual(words(browser))
    expect(svg).not.toMatch(/<style|<mask/)
    expect(remeasured).toEqual([])
    expect(() => acceptDiagram({ svg, source: '{}', sourceKind: 'excalidraw' }, { notice: 'n', provenance: 'AIGenerated=true' })).not.toThrow()
  }, 30_000)

  it('leaves the server process without a window: the DOM lives in the worker', () => {
    expect(typeof (globalThis as { window?: unknown }).window).toBe('undefined')
  })

  it('lays out a text again with the width a browser gives it once its font has loaded', async () => {
    const text = scene.find((element) => element.type === 'text' && !element.containerId)!
    const guessed = { ...text, width: 1, height: 1 }
    const { remeasured } = await renderer.render({ elements: [guessed], remeasure: [String(text.id)] })
    expect(remeasured).toHaveLength(1)
    // Chromium sets this line in Excalifont at 20 px to 447.32 px (`sketch-text-widths.json`); the title is 28 px.
    const chromium = widths.find((row) => row.text === text.text && row.font.startsWith('20px Excalifont'))!
    expect(Number(remeasured[0].width)).toBeCloseTo((chromium.width * Number(text.fontSize)) / 20, 1)
    expect(remeasured[0].height).toBe(35)
    // The fixture scene was made by convertToExcalidrawElements before Excalifont loaded: its stored width is the
    // fallback font's (ADR-0149, the font-load race). The server's layout does not depend on a load.
    expect(Number(text.width)).toBeLessThan(Number(remeasured[0].width) - 50)
  }, 30_000)

  it('draws an edit: new elements Excalidraw restores, and a box grown to the label that no longer fits it', async () => {
    const before = checkSketchScene({ type: 'excalidraw', elements: scene })
    const { scene: after } = applySketchEdit(before, [
      { op: 'update', intent: 'rename', id: 'n1', set: { label: { text: 'Wohnen und Essen mit Blick in den Garten und auf die Terrasse im Süden' } } },
      { op: 'add', intent: 'add', element: { type: 'rectangle', id: 'bath', x: 600, y: 300, label: { text: 'Bad' } } },
      { op: 'add', intent: 'join', element: { type: 'arrow', id: 'to-bath', x: 0, y: 0, start: { id: 'n1' }, end: { id: 'bath' } } },
    ])
    const remeasure = textsToMeasure(before, after)
    const { svg, remeasured } = await renderer.render({ elements: after.elements.filter((element) => !element.isDeleted) as never, remeasure })
    const grown = remeasured.find((entry) => entry.id === 'n1')
    expect(Number(grown?.height)).toBeGreaterThan(90)
    expect(grown?.width).toBe(160)
    expect(words(svg).join(' ')).toContain('Bad')
    expect(() => acceptDiagram({ svg, source: '{}', sourceKind: 'excalidraw' }, { notice: 'n', provenance: 'AIGenerated=true' })).not.toThrow()
  }, 30_000)

  it('draws an edit’s diff: added green, removed dashed red, changed blue over grey', async () => {
    const before = checkSketchScene({ type: 'excalidraw', elements: scene })
    const { scene: after, diff } = applySketchEdit(before, [
      { op: 'update', intent: 'colour', id: 'n1', set: { backgroundColor: '#a5d8ff' } },
      { op: 'remove', intent: 'drop', id: 'n0' },
      { op: 'add', intent: 'add', element: { type: 'ellipse', id: 'bath', x: 600, y: 300, label: { text: 'Bad' } } },
    ])
    const elements = sketchEditDiffElements(before, after, diff)
    const { svg } = await renderer.render({ elements, remeasure: textsToMeasure(before, after) })
    for (const colour of Object.values(DIFF_COLORS)) expect(svg.toLowerCase()).toContain(colour)
    expect(words(svg).join(' ')).toContain('Bad')
  }, 30_000)

  it('ends a render past its deadline and starts afresh for the next', async () => {
    const hanging = join(dir, 'hanging-worker.mjs')
    writeFileSync(hanging, "import { parentPort } from 'node:worker_threads'\nparentPort.on('message', () => {})\n")
    const slow = createSketchRenderer({ workerPath: hanging, fontsDir, timeoutMs: 200 })
    await expect(slow.render({ elements: [], remeasure: [] })).rejects.toMatchObject({ reason: 'timeout' })
    await expect(slow.render({ elements: [], remeasure: [] })).rejects.toBeInstanceOf(SketchRenderError)
    await slow.close()
  })

  it('gives the worker a document that runs and loads nothing', () => {
    expect(SKETCH_DOM_OPTIONS.url).toBe('about:blank')
    expect(SKETCH_DOM_OPTIONS.settings).toMatchObject({
      enableJavaScriptEvaluation: false,
      disableJavaScriptFileLoading: true,
      disableCSSFileLoading: true,
      enableImageFileLoading: false,
      disableIframePageLoading: true,
      navigation: { disableMainFrameNavigation: true, disableChildFrameNavigation: true, disableChildPageNavigation: true },
    })
  })

  it('says so when there is no renderer to start', async () => {
    const missing = createSketchRenderer({ workerPath: join(dir, 'nothing.mjs'), fontsDir })
    await expect(missing.render({ elements: [], remeasure: [] })).rejects.toMatchObject({ reason: 'unavailable' })
  })
})
