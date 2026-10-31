/**
 * @vitest-environment node
 */
/** The import's mapping of one topic's words onto an Anmerkung (`./bcf-import-map.ts`). */

import { describe, expect, it } from 'vitest'
import { bodyOf, clip, dueOnOf, kindOf, statusOf, topicKey } from './bcf-import-map'

describe('kindOf', () => {
  it('reads our own types exactly, other tools’ words by meaning, anything else as a hint', () => {
    expect(kindOf('Defect')).toEqual({ value: 'defect', exact: true })
    expect(kindOf('Clash')).toEqual({ value: 'defect', exact: false })
    expect(kindOf('Issue')).toEqual({ value: 'defect', exact: false })
    expect(kindOf('Error')).toEqual({ value: 'defect', exact: false })
    expect(kindOf('Request')).toEqual({ value: 'question', exact: false })
    expect(kindOf('question')).toEqual({ value: 'question', exact: true })
    expect(kindOf('Fire safety')).toEqual({ value: 'hint', exact: false })
    expect(kindOf(null)).toEqual({ value: 'hint', exact: false })
  })
})

describe('statusOf', () => {
  it('reads our own statuses exactly, other tools’ words by meaning, anything else as open', () => {
    expect(statusOf('Resolved')).toEqual({ value: 'resolved', exact: true })
    expect(statusOf('Closed')).toEqual({ value: 'resolved', exact: false })
    expect(statusOf('In Progress')).toEqual({ value: 'open', exact: false })
    expect(statusOf('ReOpened')).toEqual({ value: 'open', exact: false })
    expect(statusOf('Rejected')).toEqual({ value: 'dismissed', exact: false })
    expect(statusOf('Waiting for Godot')).toEqual({ value: 'open', exact: false })
  })
})

describe('dueOnOf', () => {
  it('takes the calendar day as written, and nothing that is no day', () => {
    expect(dueOnOf('2026-11-06T12:00:00Z')).toBe('2026-11-06')
    expect(dueOnOf('2026-11-06')).toBe('2026-11-06')
    expect(dueOnOf('2026-02-30T00:00:00')).toBeNull()
    expect(dueOnOf('next Friday')).toBeNull()
    expect(dueOnOf(null)).toBeNull()
  })
})

describe('bodyOf', () => {
  it('is the title, then the description; a description that starts with the title is the body', () => {
    expect(bodyOf('Sturz fehlt', null, '–')).toEqual({ body: 'Sturz fehlt', cut: false })
    expect(bodyOf('Sturz fehlt', 'Achse 4', '–').body).toBe('Sturz fehlt\n\nAchse 4')
    expect(bodyOf('Sturz fehlt', 'Sturz fehlt\nAchse 4', '–').body).toBe('Sturz fehlt\nAchse 4')
    expect(bodyOf(`${'a'.repeat(199)}…`, `${'a'.repeat(300)}\nmehr`, '–').body).toBe(`${'a'.repeat(300)}\nmehr`)
    expect(bodyOf(null, null, 'Ohne Titel').body).toBe('Ohne Titel')
  })

  it('cuts a text past the mark’s bound and says so', () => {
    const { body, cut } = bodyOf('x'.repeat(2500), null, '–')
    expect(cut).toBe(true)
    expect(Array.from(body)).toHaveLength(2000)
    expect(body.endsWith('…')).toBe(true)
    expect(clip('😀'.repeat(3), 2).text).toBe('😀…')
  })
})

describe('topicKey', () => {
  it('is the Guid, lowercase, or a stable UUIDv5 of a Guid that is none', () => {
    expect(topicKey('A2F1C3D4-5B6A-4C7D-8E9F-0A1B2C3D4E5F')).toBe('a2f1c3d4-5b6a-4c7d-8e9f-0a1b2c3d4e5f')
    expect(topicKey('TWP-12')).toBe(topicKey(' TWP-12 '))
    expect(topicKey('TWP-12')).not.toBe(topicKey('TWP-13'))
  })
})
