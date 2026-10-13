import { describe, expect, it } from 'vitest'
import { DOCUMENT_READ_FAMILIES, KNOWN_DOCUMENT_STATUSES, documentReadFamily } from './document-status'
import { SURFACE_STATES, readFamilyOfState, stateOfReadFamily, surfaceStateOf } from './surface-state'

describe('surfaceStateOf', () => {
  it.each(KNOWN_DOCUMENT_STATUSES)('%s is counted in the family its state names', (status) => {
    // The badge's word and the brief's count must agree for every declared status.
    expect(readFamilyOfState(surfaceStateOf(status))).toBe(documentReadFamily(status))
  })

  it('names each spelling of a state with one word', () => {
    expect(surfaceStateOf('ready')).toBe('citable')
    expect(surfaceStateOf('ingested')).toBe('citable')
    expect(surfaceStateOf('uploading')).toBe('reading')
    expect(surfaceStateOf('pending')).toBe('reading')
    expect(surfaceStateOf('quarantined')).toBe('held')
    expect(surfaceStateOf('error')).toBe('unreadable')
    expect(surfaceStateOf('uploaded')).toBe('stored')
  })

  it('calls an undeclared status unknown, never citable', () => {
    expect(surfaceStateOf('quasi-ready')).toBe('unknown')
    expect(surfaceStateOf(null)).toBe('unknown')
    expect(surfaceStateOf('')).toBe('unknown')
  })

  it('reads the status the way the column writes it', () => {
    expect(surfaceStateOf('READY')).toBe('citable')
  })

  it('holds a failed row that carries the gate verdict, not a failed read', () => {
    expect(surfaceStateOf({ status: 'failed', errorMessage: 'quarantined:{"reasons":[]}' })).toBe('held')
    expect(surfaceStateOf({ status: 'failed', errorMessage: 'parser crashed' })).toBe('unreadable')
  })

  it('holds a row the content check quarantined, whatever its status', () => {
    expect(surfaceStateOf({ status: 'processing', screeningOutcome: 'quarantined' })).toBe('held')
  })
})

describe('families and states', () => {
  it.each(DOCUMENT_READ_FAMILIES)('the %s family round-trips through its state', (family) => {
    expect(readFamilyOfState(stateOfReadFamily(family))).toBe(family)
  })

  it('folds unknown into reading, as the SQL counts it', () => {
    expect(readFamilyOfState('unknown')).toBe('reading')
    expect(documentReadFamily('quasi-ready')).toBe('reading')
  })

  it('lists every state once', () => {
    expect(new Set(SURFACE_STATES).size).toBe(SURFACE_STATES.length)
  })
})
