/**
 * A refused request as the code the UI words: one of the server's, or
 * `unknown`. The codes that mean the mail changed ask for a read again.
 */

import { describe, expect, it } from 'vitest'
import { ApiRequestError } from '@/adapters/api/api-error'
import { refusalNeedsReload, refusalOf, refusalTerms } from './refusal'

describe('refusalOf', () => {
  it('passes a known code through', () => {
    expect(refusalOf(new ApiRequestError('x', 409, 'sender_not_acknowledged'))).toBe('sender_not_acknowledged')
  })

  it('is unknown for anything else', () => {
    expect(refusalOf(new ApiRequestError('x', 409, 'made_up'))).toBe('unknown')
    expect(refusalOf(new ApiRequestError('x', 500))).toBe('unknown')
    expect(refusalOf(new TypeError('network'))).toBe('unknown')
  })
})

describe('refusalNeedsReload', () => {
  it('reads again after a change someone else made', () => {
    expect(refusalNeedsReload('stale')).toBe(true)
    expect(refusalNeedsReload('part_not_waiting')).toBe(true)
    expect(refusalNeedsReload('name_stop')).toBe(false)
  })
})

describe('refusalTerms', () => {
  it('names the terms a name stop refused, and nothing for any other refusal', () => {
    expect(refusalTerms(new ApiRequestError('x', 409, 'name_stop', { reason: 'name_stop', terms: ['Honorar', 7, ' '] }))).toEqual(['Honorar'])
    expect(refusalTerms(new ApiRequestError('x', 409, 'name_stop'))).toEqual([])
    expect(refusalTerms(new ApiRequestError('x', 409, 'stale', { reason: 'stale', terms: ['Honorar'] }))).toEqual([])
    expect(refusalTerms(new TypeError('network'))).toEqual([])
  })
})
