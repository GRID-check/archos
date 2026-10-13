/**
 * @vitest-environment node
 */
/**
 * The committed JSON Schema is what Piloti's file tool (`src/aiq_agent/tools/files/`)
 * is tested against, and this keeps it from going stale: it REWRITES the
 * fixture when `UPDATE_FIXTURES=1` and otherwise compares.
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { PROPOSAL_WIRE_SCHEMAS, proposalsJsonSchema } from './proposal-schema'
import { FILE_OPERATIONS, MAX_FILE_OPERATION_ITEMS } from './types'

const FIXTURE = join(process.cwd(), 'tests/fixtures/proposals.schema.json')

type Node = Record<string, unknown> & { properties?: Record<string, Node> }

describe('proposed changes JSON Schema', () => {
  it('matches the committed fixture the Python tier loads', () => {
    const generated = `${JSON.stringify(proposalsJsonSchema(), null, 2)}\n`
    if (process.env.UPDATE_FIXTURES === '1') writeFileSync(FIXTURE, generated, 'utf8')
    expect(
      readFileSync(FIXTURE, 'utf8'),
      'The wire schemas changed. Re-run with UPDATE_FIXTURES=1 and commit the fixture in the same change.'
    ).toBe(generated)
  })

  it('exports every schema the contract map names, and only those', () => {
    expect(Object.keys(proposalsJsonSchema().$defs as object).sort()).toEqual(Object.keys(PROPOSAL_WIRE_SCHEMAS).sort())
  })

  it('closes the request: the project is the envelope’s, so the body cannot name one', () => {
    const request = (proposalsJsonSchema().$defs as Record<string, Node>).InternalProposalRequest
    expect(request.additionalProperties).toBe(false)
    expect(Object.keys(request.properties ?? {}).sort()).toEqual(['answerMessageId', 'kind', 'op', 'payload'])
  })

  it('bounds the payload as the card did: four verbs, at most twenty items', () => {
    const payload = (proposalsJsonSchema().$defs as Record<string, Node>).FileOperationPayload
    const operation = payload.properties?.operation as { enum?: string[] }
    const operations = payload.properties?.operations as { maxItems?: number }
    expect(operation.enum).toEqual([...FILE_OPERATIONS])
    expect(operations.maxItems).toBe(MAX_FILE_OPERATION_ITEMS)
  })
})
