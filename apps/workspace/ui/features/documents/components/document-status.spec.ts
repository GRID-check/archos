import { describe, expect, it, vi } from 'vitest'
import {
  documentStatusLabel,
  failedWithPreviousVersion,
  isCitable,
  isCitableStatus,
  isFailedStatus,
  isNeverIndexed,
  isSettlingStatus,
} from './document-status'

describe('document status families', () => {
  it('treats ingest-reconciled completed as citable (Ask must not stay grey)', () => {
    expect(isCitableStatus('completed')).toBe(true)
    expect(isCitableStatus('ready')).toBe(true)
    expect(isCitableStatus('ingested')).toBe(true)
    expect(isCitableStatus('processing')).toBe(false)
    expect(isCitableStatus(null)).toBe(false)
  })

  it('does not treat a failed ingest as still settling', () => {
    expect(isFailedStatus('failed')).toBe(true)
    expect(isFailedStatus('error')).toBe(true)
    expect(isSettlingStatus('failed')).toBe(false)
    expect(isSettlingStatus('pending')).toBe(true)
  })

  it('reads a failed re-upload as still citable through its previous version', () => {
    expect(failedWithPreviousVersion({ status: 'failed', versionCount: 2 })).toBe(true)
    // One version: nothing earlier to fall back on.
    expect(failedWithPreviousVersion({ status: 'failed', versionCount: 1 })).toBe(false)
    // A payload that did not read the count says the conservative thing.
    expect(failedWithPreviousVersion({ status: 'failed', versionCount: null })).toBe(false)
    expect(failedWithPreviousVersion({ status: 'failed' })).toBe(false)
    // Not a failure at all.
    expect(failedWithPreviousVersion({ status: 'processing', versionCount: 3 })).toBe(false)
  })
})

describe('documentStatusLabel', () => {
  // Returns the key itself, so every assertion is about WHICH key was picked.
  const t = (key: string): string => key

  it('labels declared statuses from the table', () => {
    expect(documentStatusLabel('ready', t)).toBe('status.ready')
    expect(documentStatusLabel(null, t)).toBe('status.unknown')
  })

  it('says the bytes are still arriving while a file uploads', () => {
    expect(documentStatusLabel('uploading', t)).toBe('status.uploading')
    expect(documentStatusLabel('processing', t)).toBe('status.processing')
  })

  it('never renders a verbatim wire word for an undeclared status', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      expect(documentStatusLabel('quasi-ready', t)).toBe('status.unknown')
      expect(warn).toHaveBeenCalledTimes(1)
    } finally {
      warn.mockRestore()
    }
  })
})

/*
 * Since ADR-0054 a person may publish Piloti's document into the index, and
 * the dispatch guard lets only that published version through. Its status is
 * then the truth: an authorship override showed a published, indexed report as
 * „nicht in der Wissensbasis“ and kept Ask from opening it.
 */
describe('whether a document is in the knowledge base', () => {
  it.each(['user', 'agent'] as const)('follows the status for a document by %s', (authoredBy) => {
    const indexed = { status: 'completed', authoredBy }
    const stored = { status: 'stored', authoredBy }
    expect(isCitable(indexed)).toBe(true)
    expect(isNeverIndexed(indexed)).toBe(false)
    expect(isCitable(stored)).toBe(false)
    expect(isNeverIndexed(stored)).toBe(true)
  })

  it('reads a document still being read as neither', () => {
    expect(isCitable({ status: 'pending' })).toBe(false)
    expect(isNeverIndexed({ status: 'pending' })).toBe(false)
  })
})
