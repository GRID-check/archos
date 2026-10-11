import { describe, expect, test } from 'vitest'
import type { FileItem } from '../file-types'
import type { FassungFacts, FassungRef } from '@/lib/documents/fassung'
import { EMPTY_FASSUNG } from '@/lib/documents/fassung'
import { fassungCount, isOlderFassung, withoutOlderFassungen } from './fassung-chain'

const file = (id: string, fassung: FassungFacts | null = null): FileItem =>
  ({
    id,
    filename: `${id}.pdf`,
    displayName: null,
    fileSize: 1,
    contentType: 'application/pdf',
    status: 'ready',
    folderId: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    errorMessage: null,
    summary: null,
    pageCount: null,
    chunkCount: null,
    contentTypes: null,
    tags: null,
    topics: null,
    capture: null,
    fassung,
  }) as FileItem

const ref = (id: string): FassungRef => ({ id, filename: `${id}.pdf` })

/** `id` is superseded by `newer`. */
const olderThan = (newer: string): FassungFacts => ({ ...EMPTY_FASSUNG, supersededBy: ref(newer) })

describe('isOlderFassung', () => {
  test('is true when the newer Fassung it names is listed', () => {
    const older = file('v1', olderThan('v2'))
    expect(isOlderFassung(older, new Set(['v1', 'v2']))).toBe(true)
  })

  test('is false when the newer Fassung is not listed, so the older one stays visible', () => {
    const older = file('v1', olderThan('v2'))
    expect(isOlderFassung(older, new Set(['v1']))).toBe(false)
  })

  test('is false for a document nobody superseded, listed or not', () => {
    expect(isOlderFassung(file('v2'), new Set(['v2']))).toBe(false)
    expect(isOlderFassung(file('v2', { ...EMPTY_FASSUNG, supersedes: [ref('v1')] }), new Set(['v2']))).toBe(false)
  })
})

describe('withoutOlderFassungen', () => {
  const chain = [
    file('v1', olderThan('v2')),
    file('v2', { ...EMPTY_FASSUNG, supersedes: [ref('v1')], supersededBy: ref('v3') }),
    file('v3', { ...EMPTY_FASSUNG, supersedes: [ref('v2')] }),
    file('plain'),
  ]

  test('leaves out every older Fassung whose newer one is listed', () => {
    expect(withoutOlderFassungen(chain, false).map((f) => f.id)).toEqual(['v3', 'plain'])
  })

  test('keeps an older Fassung whose newer one is not in the listing', () => {
    const withoutNewest = chain.filter((f) => f.id !== 'v3')
    expect(withoutOlderFassungen(withoutNewest, false).map((f) => f.id)).toEqual(['v2', 'plain'])
  })

  test('returns the input itself when older Fassungen are asked for', () => {
    expect(withoutOlderFassungen(chain, true)).toBe(chain)
  })
})

describe('fassungCount', () => {
  test('counts the whole history, the document itself included', () => {
    const history = [
      { ...ref('v1'), createdAt: null, changeSummary: null },
      { ...ref('v2'), createdAt: null, changeSummary: null },
    ]
    expect(fassungCount(file('v3', { ...EMPTY_FASSUNG, supersedes: [ref('v2')], history }))).toBe(3)
  })

  test('falls back to the direct links when a surface carries no history', () => {
    expect(fassungCount(file('v3', { ...EMPTY_FASSUNG, supersedes: [ref('v1'), ref('v2')] }))).toBe(3)
  })

  test('prefers the history over the direct links when both are there', () => {
    const history = [{ ...ref('v1'), createdAt: null, changeSummary: null }]
    expect(fassungCount(file('v3', { ...EMPTY_FASSUNG, supersedes: [ref('v2'), ref('v1')], history }))).toBe(2)
  })

  test('is one for a document with no Fassung at all', () => {
    expect(fassungCount(file('solo'))).toBe(1)
    expect(fassungCount(file('solo', EMPTY_FASSUNG))).toBe(1)
  })
})
