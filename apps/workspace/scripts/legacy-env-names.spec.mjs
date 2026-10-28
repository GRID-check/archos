/**
 * @vitest-environment node
 */
import { createRequire } from 'node:module'
import { describe, expect, it } from 'vitest'

const { adoptLegacyNames, currentName } = createRequire(import.meta.url)('./legacy-env-names.cjs')

describe('currentName', () => {
  it.each([
    ['GRID_MAX_ACTIVE_JOBS_PER_ORG', 'MAX_ACTIVE_JOBS_PER_ORG'],
    ['AIQ_VLM_MODEL', 'VLM_MODEL'],
    ['GRID_ROLE', 'PROCESS_ROLE'],
    ['GRID_PILOTI_ASK_MAX_SECONDS', 'AGENT_ASK_MAX_SECONDS'],
    ['GRID_', null],
    ['PATH', null],
  ])('reads %s as %s', (legacy, current) => {
    expect(currentName(legacy)).toBe(current)
  })
})

describe('adoptLegacyNames', () => {
  it('sets the current name where unset, and a set name wins over GRID_, which wins over AIQ_', () => {
    const env = {
      GRID_INTERNAL_API_TOKEN: 't',
      AIQ_SUMMARY_DB: 'oldest',
      GRID_SUMMARY_DB: 'old',
      CHECKPOINT_DB: 'new',
      GRID_CHECKPOINT_DB: 'old',
    }
    const warnings = []

    const adopted = adoptLegacyNames(env, (line) => warnings.push(line))

    expect(adopted).toEqual(['INTERNAL_API_TOKEN', 'SUMMARY_DB'])
    expect(env).toMatchObject({ INTERNAL_API_TOKEN: 't', SUMMARY_DB: 'old', CHECKPOINT_DB: 'new' })
    expect(warnings).toContain(
      'WARNING: GRID_INTERNAL_API_TOKEN is deprecated; rename it to INTERNAL_API_TOKEN'
    )
    expect(warnings).toContain(
      'WARNING: GRID_CHECKPOINT_DB is deprecated and ignored, CHECKPOINT_DB is set'
    )
    expect(warnings).toContain(
      'WARNING: AIQ_SUMMARY_DB is deprecated and ignored, SUMMARY_DB is set'
    )
  })
})
