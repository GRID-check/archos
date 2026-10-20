/**
 * @vitest-environment node
 *
 * The body of `POST /api/projects`: Piloti sets a project up unless the person
 * says otherwise, and every new field has its bound.
 */
import { describe, expect, it } from 'vitest'
import type { GeocodeResult } from '@/lib/geocoding/types'
import { createProjectSchema } from './create-project-schema'

const location: GeocodeResult = {
  label: 'Hauptstraße 12, 1010 Wien',
  lat: 48.2,
  lon: 16.37,
  country: 'at',
  federalState: 'vienna',
  state: 'Wien',
  municipality: 'Wien',
  postcode: '1010',
  kind: 'address',
}

describe('createProjectSchema', () => {
  it('defaults the setup to piloti', () => {
    expect(createProjectSchema.parse({ name: 'Haus' })).toEqual({ name: 'Haus', setup: 'piloti' })
  })

  it('accepts self, a description, a location and a Bundesland', () => {
    const body = createProjectSchema.parse({
      name: ' Haus ',
      setup: 'self',
      description: '  Aufstockung  ',
      location,
      bundesland: 'tyrol',
    })
    expect(body).toEqual({ name: 'Haus', setup: 'self', description: 'Aufstockung', location, bundesland: 'tyrol' })
  })

  it('treats a blank description as none', () => {
    expect(createProjectSchema.parse({ name: 'Haus', description: '   ' }).description).toBeUndefined()
  })

  it('refuses a description over 500 characters, after trimming', () => {
    expect(createProjectSchema.safeParse({ name: 'Haus', description: 'a'.repeat(500) }).success).toBe(true)
    expect(createProjectSchema.safeParse({ name: 'Haus', description: 'a'.repeat(501) }).success).toBe(false)
  })

  it('refuses an unknown setup, a location outside Austria, an unknown Bundesland and stray fields', () => {
    expect(createProjectSchema.safeParse({ name: 'Haus', setup: 'wizard' }).success).toBe(false)
    expect(createProjectSchema.safeParse({ name: 'Haus', location: { ...location, country: 'de' } }).success).toBe(false)
    expect(createProjectSchema.safeParse({ name: 'Haus', bundesland: 'bayern' }).success).toBe(false)
    expect(createProjectSchema.safeParse({ name: 'Haus', extra: 1 }).success).toBe(false)
  })

  it('keeps the closing as before', () => {
    const body = createProjectSchema.parse({
      name: 'Alt',
      closing: { outcome: 'completed', endedOn: '2022-08', startedOn: null },
    })
    expect(body.closing).toEqual({ outcome: 'completed', endedOn: '2022-08', startedOn: null })
    expect(createProjectSchema.safeParse({ name: 'Alt', closing: { outcome: 'completed', endedOn: '2022-8', startedOn: null } }).success).toBe(false)
  })
})
