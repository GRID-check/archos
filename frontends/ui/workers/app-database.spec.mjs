/**
 * @vitest-environment node
 */
import { describe, expect, it } from 'vitest'
import { createSql } from './app-database.js'

describe('createSql', () => {
  it('refuses to start without the app database', () => {
    expect(() => createSql({})).toThrow('GRID_APP_DATABASE_URL is not defined')
  })

  // postgres-js connects lazily, so building the client opens nothing.
  it('builds a client without prepared statements, like the BFF behind its transaction pooler (ADR-0083)', async () => {
    const sql = createSql({ GRID_APP_DATABASE_URL: 'postgres://grid_app_rw@127.0.0.1:1/grid_app' })

    expect(sql.options.prepare).toBe(false)
    await sql.end()
  })
})
