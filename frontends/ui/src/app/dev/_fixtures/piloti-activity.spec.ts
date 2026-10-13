import { describe, expect, test } from 'vitest'
import { pilotiActivityResponseSchema } from '@/lib/piloti-activity/types'
import { pilotiActivityFixture } from './piloti-activity'

const NOW = new Date('2026-10-13T12:00:00Z')

describe('the „Was Piloti tut" fixtures', () => {
  test.each(['full', 'empty', 'waiting-only'] as const)(
    '%s parses through the contract',
    (variant) => {
      const fixture = pilotiActivityFixture(variant, NOW)
      expect(pilotiActivityResponseSchema.parse(fixture)).toEqual(fixture)
    }
  )

  test('the full variant carries every row kind of every section', () => {
    const { running, waiting, recent } = pilotiActivityFixture('full', NOW)
    expect(new Set(running.items.map((item) => item.kind))).toEqual(new Set(['wake', 'run']))
    expect(new Set(waiting.items.map((item) => item.kind))).toEqual(
      new Set(['proposal', 'proposed_marks'])
    )
    expect(new Set(recent.items.map((item) => item.kind))).toEqual(
      new Set(['wake_ended', 'run_finished', 'changes', 'proposal_decided'])
    )
  })

  test('the full variant shows each class of a failed wake and each decision of a proposal', () => {
    const { recent } = pilotiActivityFixture('full', NOW)
    const kinds = recent.items.flatMap((item) =>
      item.kind === 'wake_ended' ? [item.reasonKind] : []
    )
    expect(new Set(kinds)).toEqual(new Set(['budget', 'busy', 'access', 'error', null]))
    const decisions = recent.items.flatMap((item) =>
      item.kind === 'proposal_decided' ? [item.status] : []
    )
    expect(new Set(decisions)).toEqual(
      new Set(['applied', 'partially_applied', 'failed', 'dismissed'])
    )
  })

  test('the rows are newest first, as the contract promises', () => {
    const { running, waiting, recent } = pilotiActivityFixture('full', NOW)
    for (const items of [running.items, waiting.items, recent.items]) {
      const times = items.map((item) => Date.parse(item.at))
      expect(times).toEqual([...times].sort((a, b) => b - a))
    }
  })
})
