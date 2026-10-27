import { describe, expect, it } from 'vitest'

import { SEARCH_FIXTURE_DOCUMENTS } from '@/app/dev/_fixtures/search'
import type { DocumentHit } from '@/lib/search/search-wire'
import { registerCellEmpty, titleSpan } from './register-cells'
import { visibleRegisterColumns } from './search-sort'

const concept: DocumentHit = SEARCH_FIXTURE_DOCUMENTS[0]!
const drawing: DocumentHit = { ...concept, planNumber: 'EP-03', planIndex: 'C', planDate: '2026-10-14', scale: '1:100', documentType: 'submission_drawing' }

describe('titleSpan', () => {
  const columns = visibleRegisterColumns(null)

  it('runs the name of a document without a plan head on into the empty Planstand and Maßstab', () => {
    expect(columns.slice(columns.indexOf('title'), columns.indexOf('title') + 3)).toEqual(['title', 'planDate', 'scale'])
    expect(titleSpan(columns, concept)).toBe(3)
  })

  it('keeps a drawing\'s name in its own column', () => {
    expect(titleSpan(columns, drawing)).toBe(1)
  })

  it('stops at the first cell that says something', () => {
    expect(titleSpan(columns, { ...concept, scale: '1:100' })).toBe(2)
  })

  it('never runs into the cells before the name', () => {
    expect(titleSpan(['planNumber', 'title'], concept)).toBe(1)
  })
})

describe('registerCellEmpty', () => {
  it('counts the Büroablage as a place, though it has no project', () => {
    expect(registerCellEmpty('project', { ...concept, shelf: 'office_shelf', projectName: null })).toBe(false)
  })

  it('reads a read document\'s status as empty, the column showing only exceptions', () => {
    expect(registerCellEmpty('status', concept)).toBe(true)
  })
})
