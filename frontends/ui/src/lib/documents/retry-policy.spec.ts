import { describe, expect, it } from 'vitest'
import {
  CURRENT_INGEST_READER_VERSION,
  canRetry,
  canRetryRow,
  contentHashChanged,
  isNewerReader,
  offeredForRetry,
  parseIngestFailureCategory,
  type RetryFacts,
} from './retry-policy'

const now = { currentReaderVersion: '2026.10.1', contentHashChanged: false }
const failed = (facts: Omit<RetryFacts, 'status'>): RetryFacts => ({ status: 'failed', ...facts })

describe('canRetry', () => {
  it('says nothing about a row that did not fail', () => {
    for (const status of ['ready', 'uploaded', 'processing', 'quarantined']) {
      expect(canRetry({ status, ingestFailureCategory: 'deterministic', ingestRetryable: false }, now)).toBe(true)
    }
  })

  it('reads a passing failure again', () => {
    expect(canRetry(failed({ ingestFailureCategory: 'transient', ingestRetryable: true }), now)).toBe(true)
    expect(canRetry(failed({ ingestFailureCategory: 'configuration', ingestRetryable: true }), now)).toBe(true)
    expect(canRetry(failed({ ingestFailureCategory: 'unknown', ingestRetryable: true }), now)).toBe(true)
  })

  it('refuses a failure of the bytes while the bytes and the reader are the same', () => {
    const row = failed({ ingestFailureCategory: 'deterministic', ingestRetryable: false, ingestReaderVersion: '2026.10.1' })
    expect(canRetry(row, now)).toBe(false)
    expect(canRetry({ ...row, status: 'error' }, now)).toBe(false)
  })

  it('reads a failure of the bytes again once the bytes changed', () => {
    const row = failed({ ingestFailureCategory: 'deterministic', ingestReaderVersion: '2026.10.1' })
    expect(canRetry(row, { ...now, contentHashChanged: true })).toBe(true)
  })

  it('reads a failure of the bytes again once the reader is newer', () => {
    const row = failed({ ingestFailureCategory: 'deterministic', ingestReaderVersion: '2026.9.4' })
    expect(canRetry(row, now)).toBe(true)
  })

  it('never re-reads a held file: a reviewer decides', () => {
    expect(canRetry(failed({ ingestFailureCategory: 'quarantined', ingestRetryable: true }), now)).toBe(false)
  })

  it('keeps a row from before the category retryable unless its flag says no', () => {
    expect(canRetry(failed({}), now)).toBe(true)
    expect(canRetry(failed({ ingestRetryable: false }), now)).toBe(false)
  })

  it('reads a category this build does not know as none', () => {
    expect(canRetry(failed({ ingestFailureCategory: 'from-the-future' }), now)).toBe(true)
  })
})

describe('isNewerReader', () => {
  it('compares dotted versions as numbers', () => {
    expect(isNewerReader('2026.10.1', '2026.9.4')).toBe(true)
    expect(isNewerReader('2026.10.1', '2026.10.1')).toBe(false)
    expect(isNewerReader('2026.10.1', '2026.10.2')).toBe(false)
  })

  it('counts a missing or unparsable failed reader as older', () => {
    expect(isNewerReader('2026.10.1', null)).toBe(true)
    expect(isNewerReader('2026.10.1', 'dev')).toBe(true)
  })
})

describe('contentHashChanged', () => {
  it('needs both digests to say changed', () => {
    expect(contentHashChanged({ contentHash: 'b', metadata: { ingestContentHash: 'a' } })).toBe(true)
    expect(contentHashChanged({ contentHash: 'a', metadata: { ingestContentHash: 'a' } })).toBe(false)
    expect(contentHashChanged({ contentHash: null, metadata: { ingestContentHash: 'a' } })).toBe(false)
    expect(contentHashChanged({ contentHash: 'b', metadata: null })).toBe(false)
  })
})

describe('canRetryRow', () => {
  it('decides against the deployed reader', () => {
    const row = {
      status: 'failed',
      ingestFailureCategory: 'deterministic',
      ingestReaderVersion: CURRENT_INGEST_READER_VERSION,
    }
    expect(canRetryRow(row)).toBe(false)
    expect(canRetryRow({ ...row, contentHash: 'b', metadata: { ingestContentHash: 'a' } })).toBe(true)
  })
})

describe('parseIngestFailureCategory', () => {
  it('keeps the five known categories and nothing else', () => {
    expect(parseIngestFailureCategory('transient')).toBe('transient')
    expect(parseIngestFailureCategory('TRANSIENT')).toBeNull()
    expect(parseIngestFailureCategory(3)).toBeNull()
  })
})

describe('offeredForRetry', () => {
  it('drops only what the listing marked not retryable', () => {
    const docs = [{ id: 'a', retryable: false }, { id: 'b', retryable: true }, { id: 'c' }]
    expect(offeredForRetry(docs).map((d) => d.id)).toEqual(['b', 'c'])
  })
})
