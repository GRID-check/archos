import { describe, expect, it } from 'vitest'
import { definedValues } from './defined-values'

describe('definedValues', () => {
  it('keeps every defined value and drops the undefined ones', () => {
    expect(definedValues<number | null>({ a: 1, b: undefined, c: null })).toEqual({ a: 1, c: null })
  })

  it('answers a new object', () => {
    const record = { a: 'x' }
    expect(definedValues(record)).not.toBe(record)
  })
})
