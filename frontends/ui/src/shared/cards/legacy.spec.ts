/**
 * @vitest-environment node
 */
import { describe, expect, it } from 'vitest'
import { modernizeDraftPath, modernizeGridCard } from './legacy'
import { validateGridCards } from './schemas'

const REFERENCE = { document: 'OIB-Richtlinie 2', section: 'Pkt. 2' }
const check = (limit: number) => ({ value: 2, unit: 'm', limit, op: '>=', status: 'ok' })

describe('cards stored before the English field names', () => {
  it('reads a fire access card with its old field names', () => {
    const stored = {
      type: 'fire_access_plan',
      title: 'Zufahrt',
      parcel_width_m: 20,
      parcel_depth_m: 30,
      building_width_m: 10,
      building_depth_m: 10,
      route_width: check(3),
      aufstellflaeche: { width: check(5), length: check(10) },
      walk_distance_to_entrance: check(80),
      gebaeudeklasse: 'GK 4',
      reference: REFERENCE,
    }
    const card = modernizeGridCard(stored) as Record<string, unknown>
    expect(card).toHaveProperty('staging_area')
    expect(card).toHaveProperty('building_class', 'GK 4')
    expect(card).not.toHaveProperty('aufstellflaeche')
    expect(card).not.toHaveProperty('gebaeudeklasse')
  })

  it('keeps the English name when a card carries both', () => {
    const card = modernizeGridCard({ type: 'fire_access_plan', gebaeudeklasse: 'GK 1', building_class: 'GK 4' })
    expect(card).toMatchObject({ building_class: 'GK 4' })
    expect(card).not.toHaveProperty('gebaeudeklasse')
  })

  it('reads a railing context, a section marker, a draft path and a document source', () => {
    expect(modernizeGridCard({ type: 'guardrail_check', context: 'dachterrasse' })).toMatchObject({
      context: 'roof_terrace',
    })
    expect(
      modernizeGridCard({ type: 'building_section', markers: [{ kind: 'fluchtniveau' }, { kind: 'threshold' }] })
    ).toMatchObject({ markers: [{ kind: 'escape_level' }, { kind: 'threshold' }] })
    expect(modernizeGridCard({ type: 'document_draft', path: '/entwuerfe/a.md' })).toMatchObject({
      path: '/drafts/a.md',
    })
    expect(modernizeGridCard({ type: 'document_grid', documents: [{ source: 'buero' }, { source: 'projekt' }] })).toMatchObject({
      documents: [{ source: 'office' }, { source: 'project' }],
    })
    expect(
      modernizeGridCard({ type: 'file_operation_proposal', operations: [{ source: 'buero' }] })
    ).toMatchObject({ operations: [{ source: 'office' }] })
  })

  it('leaves a card it has no rule for, and what is not an object, as it is', () => {
    const calculation = { type: 'calculation', context: 'balkon', kind: 'projekt' }
    expect(modernizeGridCard(calculation)).toBe(calculation)
    expect(modernizeGridCard(null)).toBeNull()
    expect(modernizeGridCard('text')).toBe('text')
  })

  it('maps a draft path whichever way it is spelled, and nothing else', () => {
    expect(modernizeDraftPath('/entwuerfe/a.md')).toBe('/drafts/a.md')
    expect(modernizeDraftPath('entwuerfe/a.md')).toBe('drafts/a.md')
    expect(modernizeDraftPath(' /entwuerfe/a.md')).toBe('/drafts/a.md')
    expect(modernizeDraftPath('/drafts/a.md')).toBe('/drafts/a.md')
    expect(modernizeDraftPath('/elsewhere/a.md')).toBe('/elsewhere/a.md')
  })

  it('draws a stored draft card through the validator', () => {
    const [card] = validateGridCards([
      { type: 'document_draft', title: 'Notiz', path: '/entwuerfe/Notiz.md', bytes: 3, version: 1 },
    ])
    expect(card).toMatchObject({ type: 'document_draft', path: '/drafts/Notiz.md' })
  })

  it('maps a stored task card’s old kind, and leaves a current one', () => {
    expect(modernizeGridCard({ type: 'task_created', kind: 'einreichcheck', taskId: 't1' })).toEqual({
      type: 'task_created',
      kind: 'submission_check',
      taskId: 't1',
    })
    const current = { type: 'task_created', kind: 'submission_check', taskId: 't2' }
    expect(modernizeGridCard(current)).toBe(current)
  })
})
