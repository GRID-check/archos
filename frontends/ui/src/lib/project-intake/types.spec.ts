/**
 * @vitest-environment node
 */
import { describe, expect, it } from 'vitest'
import { closingIntentSchema, intakeDecisionsRequestSchema, MAX_INTAKE_DECISIONS } from './types'

describe('project intake contract', () => {
  it('takes a closing intent in the create form’s months', () => {
    expect(closingIntentSchema.parse({ outcome: 'completed', endedOn: '2024-06' })).toEqual({
      outcome: 'completed',
      endedOn: '2024-06',
    })
    expect(closingIntentSchema.safeParse({ outcome: 'cancelled', startedOn: null, endedOn: '2024-06' }).success).toBe(true)
    expect(closingIntentSchema.safeParse({ outcome: 'completed', endedOn: '2024-13' }).success).toBe(false)
    expect(closingIntentSchema.safeParse({ outcome: 'completed', endedOn: '2024-06-01' }).success).toBe(false)
    expect(closingIntentSchema.safeParse({ outcome: 'abandoned', endedOn: '2024-06' }).success).toBe(false)
  })

  it('holds each decision to the fields its action uses', () => {
    const parse = (decisions: unknown[]) => intakeDecisionsRequestSchema.safeParse({ decisions }).success
    expect(parse([{ key: 'bundesland', action: 'confirm' }])).toBe(true)
    expect(parse([{ key: 'bundesland', action: 'confirm', alternativeIndex: 1 }])).toBe(true)
    expect(parse([{ key: 'bundesland', action: 'answer', value: 'wien' }])).toBe(true)
    expect(parse([{ key: 'bundesland', action: 'answer' }])).toBe(false)
    expect(parse([{ key: 'bundesland', action: 'unknown', value: 'wien' }])).toBe(false)
    expect(parse([{ key: 'bundesland', action: 'confirm', alternativeIndex: 5 }])).toBe(false)
    expect(parse([])).toBe(false)
    expect(parse(Array.from({ length: MAX_INTAKE_DECISIONS + 1 }, () => ({ key: 'k', action: 'unknown' })))).toBe(false)
  })
})
