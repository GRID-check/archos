/**
 * @vitest-environment node
 */
/**
 * The two reads one listing URL carries (ADR-0102): the shelf drain, byte for
 * byte what it was, and a level read whenever a level parameter is named.
 * These pin the parsing: defaults, the limit clamp, and the cursor of the
 * wrong kind or order refused rather than silently restarting at page one.
 */

import { describe, expect, it } from 'vitest'
import { BadRequestError } from '@/lib/api/errors'
import { encodeDocumentLevelCursor, encodeDocumentListCursor } from './list-cursor'
import {
  DOCUMENT_LEVEL_PAGE_SIZE,
  clampLevelLimit,
  documentListFilterSchema,
  documentListOptions,
} from './list-query'

const ID = '00000000-0000-4000-8000-000000000001'
const FOLDER = '00000000-0000-4000-8000-0000000000f1'
const parse = (query: Record<string, string>) => documentListOptions(documentListFilterSchema.parse(query))

describe('documentListOptions — the shelf drain', () => {
  it('is what a request without level parameters has always been', () => {
    expect(parse({})).toEqual({ authoredBy: undefined, includeArchived: false, cursor: undefined })
  })

  it('takes its own cursor', () => {
    const cursor = { createdAt: '2026-01-01T00:00:00.123456', id: ID }
    expect(parse({ cursor: encodeDocumentListCursor(cursor) })).toMatchObject({ cursor })
  })

  it('refuses a level cursor rather than restarting at the first page', () => {
    const level = encodeDocumentLevelCursor({ sort: 'added', dir: 'desc', value: '2026-01-01T00:00:00.123456', id: ID })
    expect(() => parse({ cursor: level })).toThrow(BadRequestError)
  })
})

describe('documentListOptions — a level read', () => {
  it('starts on any level parameter, newest first, a hundred a page', () => {
    expect(parse({ folderId: 'root' }).level).toEqual({
      folderId: null,
      sort: 'added',
      dir: 'desc',
      limit: DOCUMENT_LEVEL_PAGE_SIZE,
    })
    expect(parse({ folderId: FOLDER }).level?.folderId).toBe(FOLDER)
  })

  it('reads the whole shelf when a search names no folder', () => {
    expect(parse({ q: '  Grundriss ' }).level).toMatchObject({ folderId: undefined, q: 'Grundriss' })
  })

  it('drops an empty search', () => {
    expect(parse({ folderId: 'root', q: '   ' }).level).not.toHaveProperty('q')
  })

  it('sorts names forwards and everything else newest or biggest first, unless told', () => {
    expect(parse({ sort: 'name' }).level).toMatchObject({ sort: 'name', dir: 'asc' })
    expect(parse({ sort: 'size' }).level).toMatchObject({ sort: 'size', dir: 'desc' })
    expect(parse({ sort: 'added', dir: 'asc' }).level).toMatchObject({ sort: 'added', dir: 'asc' })
  })

  it('takes read-state families, each once', () => {
    expect(parse({ folderId: 'root', state: 'failed,reading,failed' }).level?.states).toEqual(['failed', 'reading'])
  })

  it('never carries the drain cursor beside a level', () => {
    expect(parse({ folderId: 'root' })).not.toHaveProperty('cursor')
  })

  it('takes a cursor of its own order', () => {
    const cursor = { sort: 'name', dir: 'asc', value: 'plan.pdf', id: ID } as const
    expect(parse({ sort: 'name', cursor: encodeDocumentLevelCursor(cursor) }).level?.cursor).toEqual(cursor)
  })

  it('refuses a cursor read under another order or direction', () => {
    const cursor = encodeDocumentLevelCursor({ sort: 'name', dir: 'asc', value: 'plan.pdf', id: ID })
    expect(() => parse({ sort: 'size', cursor })).toThrow(BadRequestError)
    expect(() => parse({ sort: 'name', dir: 'desc', cursor })).toThrow(BadRequestError)
  })

  it('refuses a drain cursor on a level read', () => {
    const cursor = encodeDocumentListCursor({ createdAt: '2026-01-01T00:00:00.123456', id: ID })
    expect(() => parse({ folderId: 'root', cursor })).toThrow(BadRequestError)
  })
})

describe('clampLevelLimit', () => {
  it.each([
    [undefined, DOCUMENT_LEVEL_PAGE_SIZE],
    [0, 1],
    [-20, 1],
    [1, 1],
    [250, 250],
    [500, 500],
    [10_000, 500],
  ])('clamps %s to %s', (limit, expected) => {
    expect(clampLevelLimit(limit)).toBe(expected)
  })
})

describe('documentListFilterSchema — the level parameters', () => {
  it.each([
    ['a folder that is neither a uuid nor root', { folderId: 'inbox' }],
    ['an order the listing cannot sort by', { sort: 'status' }],
    ['a direction that is not one', { dir: 'up' }],
    ['a family nobody declared', { state: 'failed,lost' }],
    ['a limit that is not a number', { limit: 'many' }],
    ['a search longer than a name', { q: 'x'.repeat(201) }],
  ])('refuses %s', (_label, query) => {
    expect(documentListFilterSchema.safeParse(query).success).toBe(false)
  })

  it('coerces the limit from the query string', () => {
    expect(documentListFilterSchema.parse({ limit: '25' }).limit).toBe(25)
  })
})
