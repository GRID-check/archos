// @disk-inputs: app/**, bff/**, i18n/**, shared/**, types/**, ui/**, utils/**
/**
 * @vitest-environment node
 */
/**
 * Only the dispatcher may enter the acting session (ADR-0122).
 *
 * `runAsActingSession` makes `getUserSession()` answer with a session no
 * cookie proved, so every route's `authz` trusts whoever bound it. The
 * dispatcher binds a session `lib/agent-api/principal.ts` resolved from a
 * verified credential; a second caller would be a way past every gate, and
 * nothing at runtime could tell the two apart. So the rule is checked here.
 */

import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'

vi.mock('server-only', () => ({}))

import type { AuthorizedSession } from '@/lib/auth/types'
import { actingReaderIsAgent, currentActingSession, runAsActingSession } from './acting-session'
import { SOURCE_DIRS, srcKey } from '@/test-utils/source-tree'


/** The files allowed to name it: where it is defined, and the one caller. */
const ALLOWED = new Set(['lib/agent-api/acting-session.ts', 'lib/agent-api/dispatch.ts'])

function sourceFiles(dir: string): string[] {
  const found: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) found.push(...sourceFiles(path))
    else if (/\.tsx?$/.test(entry.name) && !/\.spec\.tsx?$/.test(entry.name)) found.push(path)
  }
  return found
}

describe('the acting session', () => {
  it('is entered only by the dispatcher', () => {
    const callers = SOURCE_DIRS.flatMap((dir) => sourceFiles(join(process.cwd(), dir)))
      .filter((file) => readFileSync(file, 'utf8').includes('runAsActingSession'))
      .map((file) => srcKey(file))
      .filter((file) => !ALLOWED.has(file))
    expect(callers).toEqual([])
  })

  it('says whether an agent reads the answer, so the route words it in English', async () => {
    const session = { userId: 'user_1' } as AuthorizedSession
    expect(actingReaderIsAgent()).toBe(false)
    await runAsActingSession(session, async () => {
      expect(currentActingSession()).toBe(session)
      expect(actingReaderIsAgent()).toBe(true)
    }, 'agent')
    // A person applying a proposal reads the route's words in their own language.
    await runAsActingSession(session, async () => expect(actingReaderIsAgent()).toBe(false))
    expect(currentActingSession()).toBeUndefined()
  })
})
