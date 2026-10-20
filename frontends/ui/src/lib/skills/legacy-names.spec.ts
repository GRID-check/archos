/**
 * @vitest-environment node
 */
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { canonicalSkillName, LEGACY_SKILL_NAMES, legacyNamesOf } from './legacy-names'
import { PLATFORM_SKILLS } from './platform-skills'

const BUILTIN = join(process.cwd(), '..', '..', 'src', 'aiq_agent', 'skills')

describe('builtin skill names written before the English names', () => {
  it('maps every old name to a builtin skill that ships and never to itself', () => {
    const shipped = new Set(PLATFORM_SKILLS.map((skill) => skill.name))
    for (const [legacy, current] of Object.entries(LEGACY_SKILL_NAMES)) {
      expect(shipped.has(current), current).toBe(true)
      expect(shipped.has(legacy), `${legacy} must not ship beside its replacement`).toBe(false)
      expect(canonicalSkillName(legacy)).toBe(current)
    }
    expect(canonicalSkillName('hygiene')).toBe('hygiene')
    expect(canonicalSkillName('an-org-skill')).toBe('an-org-skill')
  })

  it('lists the old names of a skill for the slash menu', () => {
    expect(legacyNamesOf('submission-check')).toEqual(['einreichcheck'])
    expect(legacyNamesOf('hygiene')).toEqual([])
  })

  it('is the table the Python agent resolves with', () => {
    const python = readFileSync(join(BUILTIN, 'builtin.py'), 'utf8')
    const block = python.slice(python.indexOf('LEGACY_SKILL_NAMES: dict'), python.indexOf('def canonical_skill_name'))
    const pairs = [...block.matchAll(/"([a-z-]+)": "([a-z-]+)"/g)].map((match) => [match[1], match[2]])
    expect(Object.fromEntries(pairs)).toEqual(LEGACY_SKILL_NAMES)
    expect(readdirSync(join(BUILTIN, 'builtin', 'oib'))).not.toContain('einreichcheck')
  })
})
