// @disk-inputs: AGENTS.md
/**
 * `next dev` rewrites `AGENTS.md` when it detects a coding agent, unless
 * `agentRules` is off (`node_modules/next/dist/server/lib/start-server.js`,
 * `syncAgentRulesForDev`). It upserted a managed block whose `##` heading
 * differed from the committed `#`, so every dev start in an agent session left
 * a tracked file dirty, and the diff landed in unrelated commits. With the
 * switch off Next only ever removes its block, which is gone already.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { nextConfig } from '../next.config'

describe("Next's agent-file generator", () => {
  it('is switched off', () => {
    expect(nextConfig.agentRules).toBe(false)
  })

  it('has no managed block left in AGENTS.md to rewrite', () => {
    const agents = readFileSync(join(__dirname, '..', 'AGENTS.md'), 'utf8')
    expect(agents).not.toContain('nextjs-agent-rules')
    expect(agents).toContain('node_modules/next/dist/docs/')
  })
})
