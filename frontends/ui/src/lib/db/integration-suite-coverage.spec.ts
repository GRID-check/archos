/**
 * @vitest-environment node
 *
 * Every Postgres integration spec runs somewhere. A `*.integration.spec.ts` that
 * reads `GRID_TEST_DATABASE_URL` skips itself everywhere except under
 * `task db:test:rls` (`scripts/rls-test-db.sh`), which names each file it runs.
 * A spec missing from that list is green in every gate and proves nothing:
 * `folder-cards/repository.integration.spec.ts` sat outside it while its review
 * asked for `task db:test:rls` before merge, which would never have run it.
 */

import { readdirSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { describe, expect, it } from 'vitest'

const UI = process.cwd()
const SCRIPT = join(UI, '..', '..', 'scripts', 'rls-test-db.sh')
const TASKFILE = join(UI, '..', '..', 'taskfiles', 'frontend.yml')

/**
 * Measurements, not gates: each runs only when asked, through its own task in
 * `taskfiles/frontend.yml`, which hands the file to `rls-test-db.sh --only`.
 */
const RUN_ON_DEMAND = new Set(['src/lib/search/search-latency.integration.spec.ts'])

/** Specs that predate this check and are not in the run. Remove a line when its spec joins the script. */
const NOT_YET_RUN = new Set([
  'src/lib/model-config/bootstrap-defaults.integration.spec.ts',
  'src/lib/model-config/platform-defaults.integration.spec.ts',
  'src/lib/model-config/service.integration.spec.ts',
  'src/lib/retrieval-settings/service.integration.spec.ts',
])

function integrationSpecs(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) return entry.name === 'node_modules' ? [] : integrationSpecs(path)
    return entry.name.endsWith('.integration.spec.ts') ? [relative(UI, path)] : []
  })
}

describe('the Postgres integration suite', () => {
  const script = readFileSync(SCRIPT, 'utf8')
  const needingPostgres = integrationSpecs(join(UI, 'src')).filter((path) =>
    readFileSync(join(UI, path), 'utf8').includes('GRID_TEST_DATABASE_URL'),
  )

  it('runs every spec that needs Postgres', () => {
    const missing = needingPostgres.filter((path) => !script.includes(path) && !NOT_YET_RUN.has(path) && !RUN_ON_DEMAND.has(path))
    expect(missing, 'Add these to scripts/rls-test-db.sh, or nothing ever runs them').toEqual([])
  })

  it('keeps the exemptions honest', () => {
    const stale = [...NOT_YET_RUN].filter((path) => script.includes(path) || !needingPostgres.includes(path))
    expect(stale, 'These run now (or are gone): drop them from NOT_YET_RUN').toEqual([])
  })

  it('gives every on-demand measurement a task that runs it', () => {
    const taskfile = readFileSync(TASKFILE, 'utf8')
    const orphaned = [...RUN_ON_DEMAND].filter((path) => !taskfile.includes(`rls-test-db.sh --only ${path}`) || !needingPostgres.includes(path))
    expect(orphaned, 'Run these through rls-test-db.sh --only from a task in taskfiles/frontend.yml, or drop them').toEqual([])
  })
})
