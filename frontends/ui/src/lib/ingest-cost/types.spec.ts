/**
 * The two wire contracts of the ingest-cost primitive, and the parsers that hold
 * each side to them.
 *
 * The point of parsing rather than casting: an `ingest_cost` this build cannot
 * read must become "no estimate", never a half-populated object rendered as
 * fact. These pin that, the snake_case → camelCase boundary between the backend's
 * report and this BFF's answer, and that the response is strict enough to fail
 * rather than render a shape it does not understand.
 */

import { describe, expect, it } from 'vitest'
import { parseBackendIngestCostReport, parseDocumentIngestCost } from './types'

describe('parseBackendIngestCostReport', () => {
  it('reads a full report, mapping snake_case to camelCase', () => {
    expect(
      parseBackendIngestCostReport({
        expected_usd: 0.52,
        upper_usd: 2.08,
        is_coarse: false,
        missing_inputs: [],
      })
    ).toEqual({ expectedUsd: 0.52, upperUsd: 2.08, isCoarse: false, missingInputs: [] })
  })

  it('keeps a coarse report a floor, with the inputs it could not measure', () => {
    expect(
      parseBackendIngestCostReport({
        expected_usd: 0.02,
        upper_usd: 0.08,
        is_coarse: true,
        missing_inputs: ['embedded_raster_sizes_px', 'scanned_pages'],
      })
    ).toEqual({
      expectedUsd: 0.02,
      upperUsd: 0.08,
      isCoarse: true,
      missingInputs: ['embedded_raster_sizes_px', 'scanned_pages'],
    })
  })

  it('reads a report with no number as no estimate, never as a free ingest', () => {
    expect(
      parseBackendIngestCostReport({
        expected_usd: null,
        upper_usd: null,
        is_coarse: true,
        missing_inputs: ['page_count'],
      })
    ).toEqual({ expectedUsd: null, upperUsd: null, isCoarse: true, missingInputs: ['page_count'] })
  })

  it('reads an absent field, a non-object and a bad shape as no estimate', () => {
    expect(parseBackendIngestCostReport(undefined)).toBeNull()
    expect(parseBackendIngestCostReport(null)).toBeNull()
    expect(parseBackendIngestCostReport('0.5')).toBeNull()
  })

  it('refuses a number that is not a non-negative finite one, and drops unknown inputs', () => {
    expect(parseBackendIngestCostReport({ expected_usd: '0.5' })?.expectedUsd).toBeNull()
    expect(parseBackendIngestCostReport({ expected_usd: 0.5, upper_usd: -1 })?.upperUsd).toBeNull()
    expect(parseBackendIngestCostReport({ expected_usd: 0.5 })?.expectedUsd).toBe(0.5)
    expect(parseBackendIngestCostReport({ missing_inputs: ['page_count', 7, ''] })?.missingInputs).toEqual([
      'page_count',
    ])
    expect(parseBackendIngestCostReport({ is_coarse: 'yes' })?.isCoarse).toBe(false)
  })
})

describe('parseDocumentIngestCost', () => {
  it('reads a full response', () => {
    expect(
      parseDocumentIngestCost({
        estimate: { expectedUsd: 0.52, upperUsd: 2.08, isCoarse: false, missingInputs: [] },
        thresholdUsd: 0.5,
        requiresConfirmation: true,
      })
    ).toEqual({
      estimate: { expectedUsd: 0.52, upperUsd: 2.08, isCoarse: false, missingInputs: [] },
      thresholdUsd: 0.5,
      requiresConfirmation: true,
    })
  })

  it('keeps a null estimate as null (nothing to show yet)', () => {
    expect(parseDocumentIngestCost({ estimate: null, thresholdUsd: 0, requiresConfirmation: false })).toEqual({
      estimate: null,
      thresholdUsd: 0,
      requiresConfirmation: false,
    })
  })

  it('throws rather than render a response it cannot read', () => {
    expect(() => parseDocumentIngestCost(null)).toThrow()
    expect(() => parseDocumentIngestCost({ estimate: null, requiresConfirmation: false })).toThrow()
    expect(() => parseDocumentIngestCost({ estimate: null, thresholdUsd: 0.5 })).toThrow()
    expect(() => parseDocumentIngestCost({ estimate: null, thresholdUsd: '0.5', requiresConfirmation: false })).toThrow()
    expect(() =>
      parseDocumentIngestCost({ estimate: { expectedUsd: 0.5 }, thresholdUsd: 0.5, requiresConfirmation: true })
    ).toThrow()
  })
})
