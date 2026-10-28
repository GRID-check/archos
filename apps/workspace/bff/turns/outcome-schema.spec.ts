// @disk-inputs: tests/fixtures/turn-outcome.schema.json
/**
 * @vitest-environment node
 */
/**
 * The committed JSON Schema is what the chat socket's outcome post is tested
 * against. REWRITES the fixture when `UPDATE_FIXTURES=1`, otherwise compares.
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { TURN_OUTCOME_WIRE_SCHEMAS, turnOutcomeJsonSchema } from './outcome-schema'

const FIXTURE = join(process.cwd(), 'tests/fixtures/turn-outcome.schema.json')

describe('turn outcome JSON Schema', () => {
  it('matches the committed fixture the chat socket loads', () => {
    const generated = `${JSON.stringify(turnOutcomeJsonSchema(), null, 2)}\n`
    if (process.env.UPDATE_FIXTURES === '1') writeFileSync(FIXTURE, generated, 'utf8')
    expect(
      readFileSync(FIXTURE, 'utf8'),
      'The wire schemas changed. Re-run with UPDATE_FIXTURES=1 and commit the fixture in the same change.'
    ).toBe(generated)
  })

  it('exports every schema the contract map names, and only those', () => {
    expect(Object.keys(turnOutcomeJsonSchema().$defs as object).sort()).toEqual(
      Object.keys(TURN_OUTCOME_WIRE_SCHEMAS).sort()
    )
  })
})
