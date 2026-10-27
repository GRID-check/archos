/**
 * @vitest-environment node
 */
/**
 * The committed JSON Schema is what the Python estate tree client is tested
 * against; this keeps it from going stale. `UPDATE_FIXTURES=1` rewrites it.
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { estateTreeJsonSchema } from './estate-tree-schema'
import { ESTATE_TREE_PAGE_MAX, ESTATE_TREE_WIRE_SCHEMAS, estateTreeRequestSchema } from './types'

const FIXTURE = join(process.cwd(), 'tests/fixtures/estate-tree.schema.json')

describe('estate tree JSON Schema', () => {
  it('matches the committed fixture the Python tier loads', () => {
    const generated = `${JSON.stringify(estateTreeJsonSchema(), null, 2)}\n`
    if (process.env.UPDATE_FIXTURES === '1') writeFileSync(FIXTURE, generated, 'utf8')
    expect(
      readFileSync(FIXTURE, 'utf8'),
      'The wire schemas changed. Re-run with UPDATE_FIXTURES=1 and commit the fixture in the same change.',
    ).toBe(generated)
  })

  it('exports every schema the contract map names, and only those', () => {
    expect(Object.keys(estateTreeJsonSchema().$defs as object).sort()).toEqual(Object.keys(ESTATE_TREE_WIRE_SCHEMAS).sort())
  })
})

describe('estateTreeRequestSchema', () => {
  it('accepts a shelf alone, and a folder with a page', () => {
    expect(estateTreeRequestSchema.safeParse({ shelf: 'project' }).success).toBe(true)
    expect(estateTreeRequestSchema.safeParse({ shelf: 'office_shelf', folder_path: 'Vorlagen', limit: 50, cursor: 'x' }).success).toBe(true)
  })

  it.each([
    ['an unknown shelf', { shelf: 'law' }],
    ['a page past the bound', { shelf: 'project', limit: ESTATE_TREE_PAGE_MAX + 1 }],
    ['a project named in the body', { shelf: 'project', project_id: '00000000-0000-4000-8000-000000000000' }],
    ['a collection named in the body', { shelf: 'project', collection: 'proj_x_r0123456789ab' }],
  ])('refuses %s', (_name, body) => {
    expect(estateTreeRequestSchema.safeParse(body).success).toBe(false)
  })
})
