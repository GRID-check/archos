/**
 * @vitest-environment node
 */
import { describe, expect, it } from 'vitest'

import { ENTITLEMENT_FLAG_SLUGS, ROLLOUT_FLAG_SLUGS } from '../src/lib/authz/feature-flags.ts'
import { diffSets, parseFlagTargets, planFlagCheck, splitList } from './provision-workos-env-plan.ts'

describe('splitList', () => {
  it('splits on commas and trims whitespace', () => {
    expect(splitList('https://a.example , https://b.example')).toEqual([
      'https://a.example',
      'https://b.example',
    ])
  })

  it('drops empty segments so a trailing comma is harmless', () => {
    expect(splitList('https://a.example,, https://b.example,')).toEqual(['https://a.example', 'https://b.example'])
  })

  it('de-duplicates while preserving first-seen order', () => {
    expect(splitList('b, a, b, a, c')).toEqual(['b', 'a', 'c'])
  })

  it('returns an empty list for unset or whitespace-only values', () => {
    expect(splitList(undefined)).toEqual([])
    expect(splitList('   ')).toEqual([])
  })
})

describe('diffSets', () => {
  it('reports nothing when the sets already agree', () => {
    expect(diffSets(['https://a', 'https://b'], ['https://b', 'https://a'])).toEqual({
      missing: [],
      extra: [],
    })
  })

  it('reports desired-but-absent as missing', () => {
    const { missing } = diffSets(['https://a', 'https://new'], ['https://a'])
    expect(missing).toEqual(['https://new'])
  })

  it('reports present-but-undesired as extra', () => {
    const { extra } = diffSets(['https://a'], ['https://a', 'http://localhost:3000'])
    expect(extra).toEqual(['http://localhost:3000'])
  })

  it('sorts both findings for stable output', () => {
    expect(diffSets(['z', 'y'], ['z', 'w', 'v'])).toEqual({ missing: ['y'], extra: ['v', 'w'] })
  })

  it('treats duplicates in the current list as one entry', () => {
    expect(diffSets([], ['x', 'x'])).toEqual({ missing: [], extra: ['x'] })
  })
})

describe('parseFlagTargets', () => {
  it('treats unset as an empty plan', () => {
    expect(parseFlagTargets(undefined)).toEqual({ ok: true, entries: [] })
    expect(parseFlagTargets('   ')).toEqual({ ok: true, entries: [] })
  })

  it('parses slug → org id arrays', () => {
    expect(parseFlagTargets('{"skills":["org_1","org_2"]}')).toEqual({
      ok: true,
      entries: [{ slug: 'skills', orgIds: ['org_1', 'org_2'] }],
    })
  })

  it('rejects malformed JSON with a structured error', () => {
    const parsed = parseFlagTargets('{skills:')
    expect(parsed.ok).toBe(false)
    if (!parsed.ok) expect(parsed.error).toContain('not valid JSON')
  })

  it('rejects non-object payloads (arrays included)', () => {
    expect(parseFlagTargets('["skills"]').ok).toBe(false)
    expect(parseFlagTargets('"skills"').ok).toBe(false)
  })

  it('rejects values that are not arrays of ids', () => {
    const parsed = parseFlagTargets('{"skills":"org_1"}')
    expect(parsed.ok).toBe(false)
    if (!parsed.ok) expect(parsed.error).toContain('must be an array')
  })

  it('rejects empty target lists — targeting nobody is a mistake, not a plan', () => {
    const parsed = parseFlagTargets('{"skills":[]}')
    expect(parsed.ok).toBe(false)
  })

  it('de-duplicates org ids within an entry', () => {
    expect(parseFlagTargets('{"skills":["org_1","org_1"]}')).toEqual({
      ok: true,
      entries: [{ slug: 'skills', orgIds: ['org_1'] }],
    })
  })
})

describe('planFlagCheck (task fe:provision:flags)', () => {
  it('passes when the environment has every registry slug', () => {
    expect(planFlagCheck(['skills', 'deep-research'], ['deep-research', 'skills'])).toEqual({
      ok: true,
      present: ['deep-research', 'skills'],
      missing: [],
      unknown: [],
    })
  })

  it('fails on a registry slug the environment lacks — it is off for everybody there', () => {
    const plan = planFlagCheck(['mail-import', 'skills'], ['skills'])
    expect(plan.ok).toBe(false)
    expect(plan.missing).toEqual(['mail-import'])
  })

  it('reports a flag no code reads without failing on it', () => {
    // A retired flag still in the dashboard is a human's to delete; the check
    // must not turn every environment red until somebody has.
    const plan = planFlagCheck(['skills'], ['skills', 'source-origin-badges', 'organization-archiv'])
    expect(plan.ok).toBe(true)
    expect(plan.unknown).toEqual(['organization-archiv', 'source-origin-badges'])
  })

  it('checks the entitlements, and asks WorkOS for no rollout (ADR-0102)', () => {
    // A rollout lives in PostHog and is on without any flag, so WorkOS lacking
    // one is not drift; one still sitting in WorkOS reads as retired.
    expect(ENTITLEMENT_FLAG_SLUGS).toEqual(expect.arrayContaining(['deep-research', 'mail-import']))
    expect(ENTITLEMENT_FLAG_SLUGS).not.toContain('post-answer-follow-ups')
    const present = ENTITLEMENT_FLAG_SLUGS.filter((slug) => slug !== 'mail-import')
    const plan = planFlagCheck(ENTITLEMENT_FLAG_SLUGS, [...present, ...ROLLOUT_FLAG_SLUGS])
    expect(plan.missing).toEqual(['mail-import'])
    expect([...plan.unknown].sort()).toEqual([...ROLLOUT_FLAG_SLUGS].sort())
  })
})
