import { it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { buildGraph } from '../src/graph/build.js'
import { inventory, roomUseKindOf } from '../src/operators/model.js'
it('classifies English room names, which a German-only lexicon missed entirely', async () => {
  const g = await buildGraph(new Uint8Array(readFileSync(new URL('./fixtures/Ifc4_SampleHouse.ifc', import.meta.url))))
  // The file is an Austrian sample house exported from an English Revit, which
  // is the ordinary case and used to classify as nothing at all.
  const habitable = inventory(g, 'habitable_room')
  expect(habitable.provenance).toBe('inferred')
  expect(habitable.value?.map((r) => r.name).sort()).toEqual(['Bedroom', 'Living room'])
  for (const room of habitable.value ?? []) {
    expect(room.confidence).toBeGreaterThanOrEqual(0.8)
    expect(room.because.join(' ')).toContain('Aufenthaltsraum')
  }
  expect(inventory(g, 'circulation').value?.map((r) => r.name)).toEqual(['Entrance hall'])
  // The fourth IfcSpace is named "Roof" and must stay unclassified rather than
  // being forced into a bucket.
  expect(inventory(g, 'ancillary_room').value).toEqual([])
}, 60000)

it('the German kind tokens still resolve for one release', () => {
  // Remove with LEGACY_ROOM_USE_KINDS.
  expect(roomUseKindOf('aufenthaltsraum')).toBe('habitable_room')
  expect(roomUseKindOf('nebenraum')).toBe('ancillary_room')
  expect(roomUseKindOf('erschliessung')).toBe('circulation')
  expect(roomUseKindOf('circulation')).toBe('circulation')
})
