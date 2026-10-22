/**
 * @vitest-environment node
 */
/**
 * The committed JSON Schema is what the Python folder-card client is tested
 * against; this keeps it from going stale. `UPDATE_FIXTURES=1` rewrites it.
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { folderCardsJsonSchema } from './folder-cards-schema'
import { FOLDER_CARD_WIRE_SCHEMAS, putFolderCardRequestSchema } from './types'

const FIXTURE = join(process.cwd(), 'tests/fixtures/folder-cards.schema.json')

const valid = {
  organization_id: 'org_1',
  collection: 'proj_1',
  folder_path: 'Vertraege',
  abstract: 'Verträge des Projekts.',
  key_facts: [{ statement: 'Werkvertrag vom 1.3.', documents: ['werkvertrag.pdf'], pages: '2-3' }],
  input_hash: 'abc',
  abstract_hash: 'def',
  model: 'm',
  prompt_version: 'v1',
  status: 'fresh',
}

describe('folder card JSON Schema', () => {
  it('matches the committed fixture the Python tier loads', () => {
    const generated = `${JSON.stringify(folderCardsJsonSchema(), null, 2)}\n`
    if (process.env.UPDATE_FIXTURES === '1') writeFileSync(FIXTURE, generated, 'utf8')
    expect(
      readFileSync(FIXTURE, 'utf8'),
      'The wire schemas changed. Re-run with UPDATE_FIXTURES=1 and commit the fixture in the same change.',
    ).toBe(generated)
  })

  it('exports every schema the contract map names, and only those', () => {
    expect(Object.keys(folderCardsJsonSchema().$defs as object).sort()).toEqual(
      Object.keys(FOLDER_CARD_WIRE_SCHEMAS).sort(),
    )
  })
})

describe('putFolderCardRequestSchema', () => {
  it('accepts a full card', () => {
    expect(putFolderCardRequestSchema.safeParse(valid).success).toBe(true)
  })

  it.each([
    ['an abstract past 600 characters', { abstract: 'a'.repeat(601) }],
    ['nine key facts', { key_facts: Array.from({ length: 9 }, () => valid.key_facts[0]) }],
    ['a key fact with no document', { key_facts: [{ statement: 's', documents: [] }] }],
    ['an unknown status', { status: 'building' }],
    ['an unknown field', { folder_id: '00000000-0000-4000-8000-000000000000' }],
  ])('refuses %s', (_name, patch) => {
    expect(putFolderCardRequestSchema.safeParse({ ...valid, ...patch }).success).toBe(false)
  })
})
