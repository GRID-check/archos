/**
 * @vitest-environment node
 *
 * A new Fassung is announced once (migration 0130): the claim is one INSERT
 * that takes the row or finds it taken, so two settles racing on one document
 * cannot both announce, and a re-read finds it taken.
 *
 * The pg-proxy harness of `list-page.spec.ts`: a real query builder over a
 * driver that records the SQL instead of connecting.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { drizzle } from 'drizzle-orm/pg-proxy'

vi.mock('server-only', () => ({}))

const captured: Array<{ sql: string; params: unknown[] }> = []
let answer: unknown[][] = []

const proxyDb = drizzle(async (sql, params) => {
  captured.push({ sql, params })
  return { rows: answer }
})

vi.mock('@/lib/db', () => ({ getDb: () => proxyDb }))
vi.mock('@/lib/db/tenant-context', () => ({ withTenant: (_scope: unknown, fn: () => unknown) => fn() }))

import { claimRevisionAnnouncement, releaseRevisionAnnouncement } from './revision-announcement-repository'

const key = { organizationId: 'org-1', documentId: 'doc-b', anchorId: 'doc-a' }

beforeEach(() => {
  captured.length = 0
  answer = []
})

describe('claimRevisionAnnouncement', () => {
  it('takes the Fassung with one insert that does nothing when it is taken already', async () => {
    answer = [['doc-b']]

    await expect(claimRevisionAnnouncement(key)).resolves.toBe(true)

    expect(captured).toHaveLength(1)
    expect(captured[0].sql).toMatch(/^insert into "document_revision_announcements"/i)
    expect(captured[0].sql).toMatch(/on conflict \("document_id","anchor_id"\) do nothing returning/i)
    expect(captured[0].params).toEqual(expect.arrayContaining(['org-1', 'doc-b', 'doc-a']))
  })

  it('answers false when the row was there: announced before, or by a concurrent settle', async () => {
    answer = []

    await expect(claimRevisionAnnouncement(key)).resolves.toBe(false)
  })
})

describe('releaseRevisionAnnouncement', () => {
  it('deletes exactly that Fassung of that organization', async () => {
    await releaseRevisionAnnouncement(key)

    expect(captured[0].sql).toMatch(/^delete from "document_revision_announcements" where/i)
    expect(captured[0].params).toEqual(['org-1', 'doc-b', 'doc-a'])
  })
})
