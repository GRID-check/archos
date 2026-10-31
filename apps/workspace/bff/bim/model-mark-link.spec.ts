import { describe, expect, it } from 'vitest'
import { modelMarkHref } from './model-mark-link'

const mark = { id: '5b1e7c2a-9d4f-4c3b-8a6e-2f1d0c9b8a7e', anchorKind: 'viewpoint' }

describe('the link to a mark on a model', () => {
  it('opens the project model at the mark', () => {
    expect(modelMarkHref({ projectId: 'p1', scope: 'project', filename: 'Haus A.ifc' }, mark)).toBe(
      '/app/projects/p1/files?model=Haus+A.ifc&mark=5b1e7c2a-9d4f-4c3b-8a6e-2f1d0c9b8a7e'
    )
  })

  it('opens an Archiv model on the Archiv', () => {
    expect(modelMarkHref({ projectId: null, scope: 'office_shelf', filename: 'Haus.ifc' }, mark)).toBe(
      '/app/office-shelf?model=Haus.ifc&mark=5b1e7c2a-9d4f-4c3b-8a6e-2f1d0c9b8a7e'
    )
  })

  it('is none for a mark on a page or a Skizze, or a document on no shelf', () => {
    expect(modelMarkHref({ projectId: 'p1', scope: 'project', filename: 'Plan.pdf' }, { ...mark, anchorKind: 'page' })).toBeNull()
    expect(modelMarkHref({ projectId: null, scope: 'session', filename: 'Haus.ifc' }, mark)).toBeNull()
  })
})
