import { describe, expect, it } from 'vitest'
import { hasHeader, legacyHeaderName, readHeader } from './legacy-header-names'

describe('legacy header names', () => {
  it('puts the old prefix back, keeping the casing', () => {
    expect(legacyHeaderName('x-internal-token')).toBe('x-grid-internal-token')
    expect(legacyHeaderName('X-Request-Context')).toBe('X-grid-Request-Context')
  })

  it('reads the current name first, then the old one', () => {
    expect(readHeader(new Headers({ 'x-internal-token': 'new', 'x-grid-internal-token': 'old' }), 'x-internal-token')).toBe('new')
    expect(readHeader(new Headers({ 'X-Grid-Request-Context': 'old' }), 'X-Request-Context')).toBe('old')
    expect(readHeader(new Headers(), 'x-internal-token')).toBeNull()
  })

  it('sees a header under either name', () => {
    expect(hasHeader(new Headers({ 'x-grid-room-peer': 'p' }), 'x-room-peer')).toBe(true)
    expect(hasHeader(new Headers(), 'x-room-peer')).toBe(false)
  })
})
