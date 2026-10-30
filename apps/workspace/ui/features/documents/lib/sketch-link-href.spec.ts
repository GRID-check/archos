/**
 * @vitest-environment node
 */
import { describe, expect, it } from 'vitest'
import type { ResolvedSketchLink } from '@/lib/diagrams/sketch-links'
import { sketchLinkHref } from './sketch-link-href'

const GLOBAL_ID = '2O2Fr$t4X7Zf8NOew3FLOH'
const project = { shelf: 'project' as const, projectId: 'proj_1', documentId: 'doc_1' }
const shelf = { shelf: 'office_shelf' as const, projectId: null, documentId: 'doc_1' }

describe('sketchLinkHref', () => {
  it('opens a document at its page on its shelf', () => {
    const link: ResolvedSketchLink = { elementId: 'a', kind: 'document', ref: { documentId: 'doc_1', page: 12 }, state: 'available', title: 'Plan', place: project, page: 12 }
    expect(sketchLinkHref(link)).toBe('/app/projects/proj_1/files?doc=doc_1&page=12')
    expect(sketchLinkHref({ ...link, place: shelf, page: undefined })).toBe('/app/office-shelf?doc=doc_1')
  })

  it('opens the model view with the element selected', () => {
    const link: ResolvedSketchLink = {
      elementId: 'a',
      kind: 'ifcElement',
      ref: { documentId: 'doc_1', ifcGlobalId: GLOBAL_ID },
      state: 'available',
      title: 'Wohnen (IfcSpace)',
      place: project,
      modelFile: 'Haus.ifc',
    }
    const href = new URL(sketchLinkHref(link) as string, 'https://app.example')
    expect(href.pathname).toBe('/app/projects/proj_1/files')
    expect(href.searchParams.get('model')).toBe('Haus.ifc')
    expect(href.searchParams.get('element')).toBe(GLOBAL_ID)
  })

  it('opens an Anmerkung in its document’s review, and an unavailable link nowhere', () => {
    const ref = { documentId: 'doc_1', annotationId: 'ann_1' }
    const link: ResolvedSketchLink = { elementId: 'a', kind: 'annotation', ref, state: 'available', title: 'x', place: project, status: 'open' }
    expect(sketchLinkHref(link)).toBe('/app/projects/proj_1/files?doc=doc_1&review=1&mark=ann_1')
    expect(sketchLinkHref({ ...link, place: shelf })).toBe('/app/office-shelf?doc=doc_1&review=1&mark=ann_1')
    expect(sketchLinkHref({ elementId: 'a', kind: 'annotation', ref, state: 'unavailable' })).toBeNull()
  })
})
