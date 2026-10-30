/**
 * Paths that assume text ask what they hold (the interference audit's C1, G5):
 * a revision run's Markdown is never written into a Skizze, and the text
 * compare reads a Skizze as its outline. The review controls not offering
 * Piloti a drawing to revise: `ui/features/documents/lib/document-lifecycle.spec.ts`.
 */

import { describe, expect, it, vi } from 'vitest'

vi.mock('server-only', () => ({}))
vi.mock('@/lib/organizations/display-name', () => ({ getOrganizationDisplayName: async () => 'Office' }))

import { acceptDiagram } from '@/lib/diagrams/svg'
import { comparableText } from '@/lib/diagrams/sketch-outline-text'
import { renderVersionBytes } from './version-content'
import { comparableAsText, NOT_REVISABLE_AS_TEXT, revisableAsText } from './text-content'

const SKETCH_SVG = acceptDiagram(
  {
    svg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 50"><rect width="40" height="20"/></svg>',
    source: JSON.stringify({
      type: 'excalidraw',
      elements: [
        { id: 'room', type: 'rectangle', x: 0, y: 0 },
        { id: 'room-label', type: 'text', x: 2, y: 2, text: 'Küche', containerId: 'room' },
        { id: 'hall', type: 'ellipse', x: 50, y: 0 },
        { id: 'hall-label', type: 'text', x: 52, y: 2, text: 'Flur', containerId: 'hall' },
        { id: 'way', type: 'arrow', x: 0, y: 0, startBinding: { elementId: 'room' }, endBinding: { elementId: 'hall' } },
      ],
      appState: {},
      files: {},
    }),
    sourceKind: 'excalidraw',
  },
  { notice: 'n', provenance: 'AIGenerated=true' }
).svg

describe('which bytes are text', () => {
  it('takes text/* and JSON, and a version from before the column; refuses a drawing, a PDF, an image', () => {
    for (const type of ['text/markdown', 'text/plain; charset=utf-8', 'application/json', null]) expect(revisableAsText(type)).toBe(true)
    for (const type of ['image/svg+xml', 'application/pdf', 'image/png']) expect(revisableAsText(type)).toBe(false)
  })
})

describe('revise from comment on a Skizze (C1)', () => {
  it('refuses to store a revision run’s Markdown as the bytes of an image/svg+xml version, by name', async () => {
    const document = { authoredBy: 'agent', authoredByProducer: 'diagram_svg', authoredByRef: 'r1', id: 'd1', organizationId: 'o1' } as never
    const version = { contentType: 'image/svg+xml' } as never
    await expect(renderVersionBytes(document, version, '# Überarbeitet\n\n- Treppenhaus verschoben')).rejects.toMatchObject({
      status: 415,
      details: { reason: NOT_REVISABLE_AS_TEXT },
    })
  })

  it('still writes a person’s Markdown draft as it is', async () => {
    const document = { authoredBy: 'user', id: 'd2', organizationId: 'o1' } as never
    const rendered = await renderVersionBytes(document, { contentType: 'text/markdown' } as never, '# Notiz')
    expect(rendered.bytes.toString('utf8')).toBe('# Notiz')
  })
})

describe('comparing Fassungen of a Skizze (G5)', () => {
  it('compares the outline, not the markup: shapes by label, connections by their ends', () => {
    const text = comparableText('image/svg+xml', SKETCH_SVG)
    expect(text).not.toContain('<svg')
    expect(text.split('\n')).toEqual(['▭ „Küche“', '◯ „Flur“', '„Küche“ → „Flur“'])
  })

  // The coherence review's finding 6: an SVG with no scene, XML and YAML compared before the Skizze slice and must again.
  it('passes text and markup through, and refuses bytes that are not text', () => {
    expect(comparableText('text/markdown', '# A')).toBe('# A')
    const plain = '<svg xmlns="http://www.w3.org/2000/svg"/>'
    expect(comparableText('image/svg+xml', plain)).toBe(plain)
    expect(comparableText('application/xml', '<a/>')).toBe('<a/>')
    expect(comparableText('application/yaml', 'a: 1')).toBe('a: 1')
    expect(comparableText('application/vnd.custom+xml', '<b/>')).toBe('<b/>')
    expect(() => comparableText('application/pdf', '%PDF')).toThrow(expect.objectContaining({ status: 415 }))
    expect(() => comparableText('image/png', 'x')).toThrow(expect.objectContaining({ status: 415 }))
  })

  it('a compare of what no model may rewrite: markup compares, it is still no revision', () => {
    for (const type of ['image/svg+xml', 'application/xml', 'application/yaml']) {
      expect(comparableAsText(type)).toBe(true)
      expect(revisableAsText(type)).toBe(false)
    }
    expect(comparableAsText('application/pdf')).toBe(false)
  })
})
