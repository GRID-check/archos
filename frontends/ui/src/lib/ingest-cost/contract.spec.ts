/**
 * The ingest-cost threshold: the number, the values it may take, and the one
 * rule that turns it into a question.
 *
 * What these protect, in order of how expensive the bug would be:
 *   - an organisation with no value of its own gets the deployment default;
 *   - a cost exactly AT the threshold does not ask, and one over it does — the
 *     off-by-one that would either nag on every upload or never ask at all;
 *   - a stored 0 switches the step OFF rather than asking about every cost;
 *   - a number the pre-read could not produce never asks, because "we cannot
 *     price this" is not "this is expensive".
 */

import { describe, expect, it } from 'vitest'
import {
  DEFAULT_INGEST_COST_THRESHOLD_USD,
  MAX_INGEST_COST_THRESHOLD_USD,
  MIN_INGEST_COST_THRESHOLD_USD,
  ingestCostThresholdPutSchema,
  shouldConfirmIngest,
} from './contract'

describe('the ingest-cost threshold constants', () => {
  it('defaults to half a dollar, may be switched off with 0, and tops out at 100', () => {
    expect(DEFAULT_INGEST_COST_THRESHOLD_USD).toBe(0.5)
    expect(MIN_INGEST_COST_THRESHOLD_USD).toBe(0)
    expect(MAX_INGEST_COST_THRESHOLD_USD).toBe(100)
  })
})

describe('shouldConfirmIngest', () => {
  it('does not ask at exactly the threshold, and asks just above it', () => {
    expect(shouldConfirmIngest(0.5, 0.5)).toBe(false)
    expect(shouldConfirmIngest(0.4999, 0.5)).toBe(false)
    expect(shouldConfirmIngest(0.5001, 0.5)).toBe(true)
  })

  it('never asks when the pre-read could not price the file', () => {
    expect(shouldConfirmIngest(null, 0.5)).toBe(false)
    expect(shouldConfirmIngest(undefined, 0.5)).toBe(false)
  })

  it('never asks for a cost that is not a positive number', () => {
    expect(shouldConfirmIngest(0, 0.5)).toBe(false)
    expect(shouldConfirmIngest(-1, 0.5)).toBe(false)
    expect(shouldConfirmIngest(Number.NaN, 0.5)).toBe(false)
    expect(shouldConfirmIngest(Number.POSITIVE_INFINITY, 0.5)).toBe(false)
  })

  it('never asks when the threshold itself switches the step off (0 or below)', () => {
    expect(shouldConfirmIngest(5, 0)).toBe(false)
    expect(shouldConfirmIngest(5, -1)).toBe(false)
    expect(shouldConfirmIngest(5, Number.NaN)).toBe(false)
  })

  it('asks for a large cost above a normal threshold', () => {
    expect(shouldConfirmIngest(2.08, 0.5)).toBe(true)
  })
})

describe('ingestCostThresholdPutSchema', () => {
  it('accepts a value in range, the two endpoints, and null', () => {
    for (const value of [0, 0.5, 100, null]) {
      expect(ingestCostThresholdPutSchema.safeParse({ ingestCostConfirmationThresholdUsd: value }).success).toBe(
        true
      )
    }
  })

  it('refuses out-of-range, non-numeric and missing values', () => {
    for (const body of [
      { ingestCostConfirmationThresholdUsd: -1 },
      { ingestCostConfirmationThresholdUsd: 100.01 },
      { ingestCostConfirmationThresholdUsd: Number.NaN },
      { ingestCostConfirmationThresholdUsd: '0.5' },
      {},
    ]) {
      expect(ingestCostThresholdPutSchema.safeParse(body).success).toBe(false)
    }
  })
})
