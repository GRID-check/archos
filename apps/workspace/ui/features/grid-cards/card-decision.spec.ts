/**
 * @vitest-environment node
 */
import { describe, expect, it } from 'vitest'
import type { AnswerCard } from '@/shared/cards/schemas'
import {
  ACTING_CARD_TYPES,
  CARD_INTERACTIVITY,
  cardKey,
  cardKeyOfDecisionKey,
  INTERACTIVE_CARD_TYPES,
  isCardDecision,
  isInteractiveCardType,
  isLiveCardType,
  itemDecisionKey,
  LIVE_CARD_TYPES,
  reconcileCardInteractions,
  sanitizeCardInteractions,
} from './card-decision'

describe('card classification', () => {
  it('classifies the canvas card as live: its objects are the record, not the message', () => {
    expect(CARD_INTERACTIVITY.canvas_activity).toBe('live')
    expect(isLiveCardType('canvas_activity')).toBe(true)
    // A live card is not a pending decision: nothing on the message waits for an answer.
    expect(isInteractiveCardType('canvas_activity')).toBe(false)
    expect(INTERACTIVE_CARD_TYPES).not.toContain('canvas_activity')
    expect(LIVE_CARD_TYPES).toEqual(['canvas_activity'])
  })

  it('keeps the three classes apart, and counts both acting classes as acting', () => {
    for (const type of LIVE_CARD_TYPES) expect(INTERACTIVE_CARD_TYPES).not.toContain(type)
    expect(new Set(ACTING_CARD_TYPES)).toEqual(new Set([...INTERACTIVE_CARD_TYPES, ...LIVE_CARD_TYPES]))
    expect(ACTING_CARD_TYPES).toHaveLength(INTERACTIVE_CARD_TYPES.length + LIVE_CARD_TYPES.length)
    expect(isLiveCardType('calculation')).toBe(false)
    expect(isInteractiveCardType('memory_proposal')).toBe(true)
  })
})

describe('cardKey', () => {
  it('identifies a card by its type and position in the message', () => {
    expect(cardKey({ type: 'memory_proposal' }, 0)).toBe('memory_proposal-0')
    expect(cardKey({ type: 'project_profile_patch' }, 2)).toBe('project_profile_patch-2')
  })

  it('separates two cards of the same type in one message', () => {
    expect(cardKey({ type: 'memory_proposal' }, 0)).not.toBe(cardKey({ type: 'memory_proposal' }, 1))
  })
})

describe('isCardDecision', () => {
  it('accepts the closed union', () => {
    for (const decision of ['accepted', 'rejected', 'savedOrg', 'savedProject', 'dismissed']) {
      expect(isCardDecision(decision)).toBe(true)
    }
  })

  it('rejects anything else', () => {
    expect(isCardDecision('pending')).toBe(false)
    expect(isCardDecision('')).toBe(false)
    expect(isCardDecision(undefined)).toBe(false)
    expect(isCardDecision({ decision: 'accepted' })).toBe(false)
  })
})

describe('reconcileCardInteractions', () => {
  const decided = (key: string) => ({
    [key]: { decision: 'accepted' as const, decidedAt: '2026-07-28T09:00:00.000Z' },
  })

  const memory = (content: string) =>
    ({
      type: 'memory_proposal',
      title: 'Merken?',
      content,
      kind: 'preference',
      confidence: 'high',
    }) as unknown as AnswerCard

  const summary = () => ({ type: 'summary', title: 'Überblick' }) as unknown as AnswerCard

  it('keeps a decision when the card at that index is unchanged', () => {
    const cards = [summary(), memory('REI 90')]
    expect(reconcileCardInteractions(decided('memory_proposal-1'), cards, [...cards])).toEqual(
      decided('memory_proposal-1'),
    )
  })

  it('drops a decision when a card is inserted ahead of the answered one', () => {
    // A streaming answer replaces `message.cards` wholesale; without this the
    // recorded key would point at a DIFFERENT card.
    const before = [memory('REI 90')]
    const after = [summary(), memory('REI 90')]
    expect(reconcileCardInteractions(decided('memory_proposal-0'), before, after)).toBeUndefined()
  })

  it('drops a decision when the same card TYPE at that index carries a different proposal', () => {
    // The critical case: same type, same index, different content. Carrying
    // "accepted" over would mark a proposal the user never saw as decided.
    const before = [memory('REI 90')]
    const after = [memory('REI 60')]
    expect(reconcileCardInteractions(decided('memory_proposal-0'), before, after)).toBeUndefined()
  })

  it('drops a decision whose card disappeared entirely', () => {
    const before = [memory('REI 90')]
    expect(reconcileCardInteractions(decided('memory_proposal-0'), before, [summary()])).toBeUndefined()
    expect(reconcileCardInteractions(decided('memory_proposal-0'), before, [])).toBeUndefined()
    expect(reconcileCardInteractions(decided('memory_proposal-0'), before, undefined)).toBeUndefined()
    expect(reconcileCardInteractions(decided('memory_proposal-0'), undefined, before)).toBeUndefined()
  })

  it('keeps only the still-valid subset, at their ORIGINAL indices', () => {
    const interactions = {
      ...decided('memory_proposal-0'),
      'summary-1': { decision: 'rejected' as const, decidedAt: '2026-07-28T09:00:00.000Z' },
    }
    const before = [memory('REI 90'), summary()]
    // Index 0 unchanged, index 1 replaced → only index 0's decision survives.
    const after = [memory('REI 90'), memory('etwas anderes')]
    expect(reconcileCardInteractions(interactions, before, after)).toEqual(decided('memory_proposal-0'))
  })

  it('drops a decision whose index is now a rejected-card hole', () => {
    // `validateAnswerCards` keeps wire positions with `undefined` holes rather
    // than renumbering: a hole carries no card, so nothing can be decided
    // about it, and the decision must not slide onto a neighbour.
    const before = [memory('REI 90')]
    const after = [undefined]
    expect(reconcileCardInteractions(decided('memory_proposal-0'), before, after)).toBeUndefined()
  })

  it('keeps later decisions bound when an earlier slot is a hole', () => {
    // The middle-card-drop case: the hole holds index 1, so the proposal at
    // index 2 is still the proposal the key was recorded against.
    const cards = [memory('REI 90'), undefined, memory('Fluchtniveau')]
    expect(reconcileCardInteractions(decided('memory_proposal-2'), cards, [...cards])).toEqual(
      decided('memory_proposal-2'),
    )
    expect(reconcileCardInteractions(decided('memory_proposal-1'), cards, [...cards])).toBeUndefined()
  })

  it('is a no-op when nothing was decided', () => {
    expect(reconcileCardInteractions(undefined, [memory('x')], [memory('x')])).toBeUndefined()
  })
})

describe('item decisions', () => {
  const decided = (key: string) => ({
    [key]: { decision: 'rejected' as const, decidedAt: '2026-10-13T09:00:00.000Z' },
  })
  const canvas = (body: string) =>
    ({
      type: 'canvas_activity',
      document: { id: '00000000-0000-4000-8000-0000000000d1', name: 'Grundriss EG.pdf' },
      items: [
        { action: 'proposed', annotation_id: 'ann-7', number: 7, page: 1, shape: 'point', x: 0.1, y: 0.1, kind: 'hint', body },
      ],
    }) as unknown as AnswerCard

  it('keys one item under its card and reads the card back out of the key', () => {
    const key = itemDecisionKey('canvas_activity-2', 'ann-7')
    expect(key).toBe('canvas_activity-2#ann-7')
    expect(cardKeyOfDecisionKey(key)).toBe('canvas_activity-2')
    expect(cardKeyOfDecisionKey('memory_proposal-0')).toBe('memory_proposal-0')
  })

  it('fits the route’s 64-character key with a uuid at the highest index', () => {
    expect(itemDecisionKey('canvas_activity-19', '00000000-0000-4000-8000-000000000000').length).toBeLessThanOrEqual(64)
  })

  it('keeps an item decision while its card is unchanged, and drops it with the card', () => {
    const before = [canvas('Treppe')]
    const key = itemDecisionKey('canvas_activity-0', 'ann-7')
    expect(reconcileCardInteractions(decided(key), before, [canvas('Treppe')])).toEqual(decided(key))
    expect(reconcileCardInteractions(decided(key), before, [canvas('Tür')])).toBeUndefined()
  })
})

describe('sanitizeCardInteractions', () => {
  it('keeps well-formed entries', () => {
    const raw = {
      'memory_proposal-0': { decision: 'savedOrg', decidedAt: '2026-07-28T09:00:00.000Z' },
    }
    expect(sanitizeCardInteractions(raw)).toEqual(raw)
  })

  it('drops entries whose decision is not in the union', () => {
    // A message row written by a future/foreign build must never smuggle an
    // unknown lifecycle state into the renderer.
    const clean = sanitizeCardInteractions({
      'memory_proposal-0': { decision: 'exfiltrated', decidedAt: '2026-07-28T09:00:00.000Z' },
      'memory_proposal-1': { decision: 'dismissed', decidedAt: '2026-07-28T09:00:00.000Z' },
    })
    expect(clean).toEqual({
      'memory_proposal-1': { decision: 'dismissed', decidedAt: '2026-07-28T09:00:00.000Z' },
    })
  })

  it('substitutes an unusable timestamp rather than dropping the decision', () => {
    // What it emits must be exactly what the PATCH route accepts: the client
    // re-sends the WHOLE map, so one unparseable entry rehydrated from a
    // foreign row would 400 every later decision on that message — silently,
    // because the mirror only warns.
    for (const bad of [undefined, 42, 'yesterday', '2026-13-45', '2026-07-28T09:00:00+02:00']) {
      const clean = sanitizeCardInteractions({ 'x-0': { decision: 'accepted', decidedAt: bad } })
      expect(clean?.['x-0'].decision).toBe('accepted')
      expect(clean?.['x-0'].decidedAt).toBe(new Date(0).toISOString())
    }
  })

  it('keeps every UTC ISO form the PATCH route accepts as-is', () => {
    // `.datetime()` requires `Z` and seconds but leaves the fractional part
    // optional, so second- and microsecond-precision instants are just as
    // valid as `toISOString()`'s three digits. Clobbering them to the epoch
    // would silently rewrite another client's history.
    for (const good of [
      '2026-07-28T09:00:00.000Z',
      '2026-07-28T09:00:00Z',
      '2026-07-28T09:00:00.123456Z',
    ]) {
      const clean = sanitizeCardInteractions({ 'x-0': { decision: 'accepted', decidedAt: good } })
      expect(clean?.['x-0'].decidedAt).toBe(good)
    }
  })

  it('returns undefined for non-objects and for input with nothing usable', () => {
    expect(sanitizeCardInteractions(undefined)).toBeUndefined()
    expect(sanitizeCardInteractions(null)).toBeUndefined()
    expect(sanitizeCardInteractions('accepted')).toBeUndefined()
    expect(sanitizeCardInteractions([{ decision: 'accepted' }])).toBeUndefined()
    expect(sanitizeCardInteractions({})).toBeUndefined()
    expect(sanitizeCardInteractions({ 'x-0': { decision: 'nope' } })).toBeUndefined()
  })
})
