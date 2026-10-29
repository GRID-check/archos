/**
 * @vitest-environment node
 */
import { describe, expect, it } from 'vitest'
import { MAX_DIAGRAM_SVG_BYTES } from './diagram-sources'
import { storedDiagramSource } from './stored-source'
import { acceptDiagram } from './svg'

const MARKING = { notice: 'Von Piloti entworfen', provenance: 'AIGenerated=true' }

describe('storedDiagramSource', () => {
  it('reads back exactly the scene filing wrote, escapes and all', () => {
    const source = JSON.stringify({ type: 'excalidraw', elements: [{ id: 'a', text: 'A < B & "C" > Ä' }] })
    const stored = acceptDiagram(
      { svg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><rect width="10" height="10"/></svg>', source, sourceKind: 'excalidraw' },
      MARKING
    ).svg
    expect(storedDiagramSource(stored)).toEqual({ kind: 'excalidraw', source })
  })

  it('reads a sketch whose stored file is larger than the SVG cap, which the parser would refuse', () => {
    const picture = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><text>${'x'.repeat(MAX_DIAGRAM_SVG_BYTES - 200)}</text></svg>`
    const source = JSON.stringify({ type: 'excalidraw', elements: [], padding: 'y'.repeat(400_000) })
    const stored = acceptDiagram({ svg: picture, source, sourceKind: 'excalidraw' }, MARKING).svg
    expect(stored.length).toBeGreaterThan(MAX_DIAGRAM_SVG_BYTES)
    expect(storedDiagramSource(stored)?.source).toBe(source)
  })

  it('finds nothing in an SVG without the server’s metadata', () => {
    expect(storedDiagramSource('<svg><metadata>{"type":"excalidraw"}</metadata></svg>')).toBeNull()
  })
})
