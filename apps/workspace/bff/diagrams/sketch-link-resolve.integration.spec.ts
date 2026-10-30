/**
 * @vitest-environment node
 *
 * A Skizze's links against a REAL Postgres: an id that is no uuid, bound to a
 * uuid column, makes Postgres throw (22P02). The schema keeps such a link out
 * of every new scene (`sketch-links.ts`), but a scene stored before it, or a
 * row a bug writes, must still read: the link is `unavailable`, never a failed
 * sketch. A mock cannot show that, because the thing that throws is the
 * database's cast. Runs with the RLS suite (`task db:test:rls`):
 *
 *   scripts/rls-test-db.sh --only bff/diagrams/sketch-link-resolve.integration.spec.ts
 */

import { sql } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import type { AuthorizedSession } from '@/lib/auth/types'

vi.mock('server-only', () => ({}))

const url = process.env.TEST_DATABASE_URL
const ORG = `org_sketch_links_${Date.now()}`

describe('the sketch-link suite is not silently skipped in CI', () => {
  it('has a database to run against', () => {
    if (!process.env.RLS_SUITE_REQUIRED) return
    expect(url, 'TEST_DATABASE_URL is unset while RLS_SUITE_REQUIRED is set. Check `task db:test:rls`.').toBeTruthy()
  })
})

describe.skipIf(!url)('resolveSketchLinks against Postgres', () => {
  let resolveSketchLinks: typeof import('./sketch-link-resolve').resolveSketchLinks
  let closeDb: typeof import('@/lib/db').closeDb
  let shelfDocument: string
  const session = { organizationId: ORG, userId: 'user_sketch' } as AuthorizedSession

  beforeAll(async () => {
    process.env.APP_DATABASE_URL = url
    const { getDb, closeDb: close } = await import('@/lib/db')
    const { withPlatformAccess } = await import('@/lib/db/tenant-context')
    closeDb = close
    resolveSketchLinks = (await import('./sketch-link-resolve')).resolveSketchLinks
    const rows = await withPlatformAccess('seed a Büroablage document', () =>
      getDb().execute<{ id: string }>(sql`
        INSERT INTO documents (organization_id, created_by, filename, storage_key, collection_name, status, scope)
        VALUES (${ORG}, 'seed', 'polierplan.pdf', 'seed/polierplan.pdf', 'seed', 'completed', 'office_shelf')
        RETURNING id
      `)
    )
    shelfDocument = Array.from(rows)[0].id
  }, 60_000)

  afterAll(async () => {
    await closeDb?.()
  })

  it('reads a link whose ids are no uuids as unavailable, and the valid link beside it as available', async () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const resolved = await resolveSketchLinks(session, [
      { elementId: 'bad-document', kind: 'document', ref: { documentId: 'Polierplan', page: 12 } },
      { elementId: 'bad-annotation', kind: 'annotation', ref: { documentId: shelfDocument, annotationId: 'ann_1' } },
      { elementId: 'bad-version', kind: 'document', ref: { documentId: shelfDocument, versionId: 'ver_1' } },
      { elementId: 'good', kind: 'document', ref: { documentId: shelfDocument, page: 2 } },
    ])
    expect(resolved.map((entry) => [entry.elementId, entry.state])).toEqual([
      ['bad-document', 'unavailable'],
      ['bad-annotation', 'unavailable'],
      ['bad-version', 'unavailable'],
      ['good', 'available'],
    ])
    expect(resolved[3]).toMatchObject({ title: 'polierplan.pdf', page: 2, place: { shelf: 'office_shelf', documentId: shelfDocument } })
    // Each refused lookup was a database fault, logged, not a refusal of access.
    expect(logged).toHaveBeenCalledTimes(3)
    logged.mockRestore()
  })
})
