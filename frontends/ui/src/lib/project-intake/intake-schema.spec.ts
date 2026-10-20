/**
 * @vitest-environment node
 */
/**
 * The committed JSON Schema is what the Erfassungs-Agent's tools
 * (`src/aiq_agent/agents/intake/`) are tested against, and this keeps it from
 * going stale: it REWRITES the fixture when `UPDATE_FIXTURES=1` and otherwise
 * compares.
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { INTAKE_WIRE_SCHEMAS, projectIntakeJsonSchema } from './intake-schema'
import {
  INTAKE_NEED_TYPES,
  MAX_EVIDENCE_QUOTE_LENGTH,
  MAX_RECORD_VALUES,
  internalIntakeRequestSchema,
} from './types'

const FIXTURE = join(process.cwd(), 'tests/fixtures/project-intake.schema.json')

type Node = Record<string, unknown> & { properties?: Record<string, Node>; oneOf?: Node[] }

const defs = () => projectIntakeJsonSchema().$defs as Record<string, Node>

describe('project intake JSON Schema', () => {
  it('matches the committed fixture the Python tier loads', () => {
    const generated = `${JSON.stringify(projectIntakeJsonSchema(), null, 2)}\n`
    if (process.env.UPDATE_FIXTURES === '1') writeFileSync(FIXTURE, generated, 'utf8')
    expect(
      readFileSync(FIXTURE, 'utf8'),
      'The wire schemas changed. Re-run with UPDATE_FIXTURES=1 and commit the fixture in the same change.'
    ).toBe(generated)
  })

  it('exports every schema the contract map names, and only those', () => {
    expect(Object.keys(defs()).sort()).toEqual(Object.keys(INTAKE_WIRE_SCHEMAS).sort())
  })

  it('closes every op: the project is the envelope’s, and every op names its reading', () => {
    const request = defs().InternalIntakeRequest
    expect(request.oneOf?.map((option) => (option.properties?.op as { const?: string }).const)).toEqual([
      'needs',
      'record',
      'withdraw',
      'progress',
      'finish',
    ])
    for (const option of request.oneOf ?? []) {
      expect(option.additionalProperties).toBe(false)
      expect(option.required).toContain('jobId')
      expect(Object.keys(option.properties ?? {})).not.toContain('projectId')
    }
  })

  it('bounds a record as the BFF does: twenty values, a closed evidence, a 400-character quote', () => {
    const record = defs().InternalIntakeRequest.oneOf?.find(
      (option) => (option.properties?.op as { const?: string }).const === 'record'
    )
    const values = record?.properties?.values as Node & { maxItems?: number; items?: Node }
    expect(values.maxItems).toBe(MAX_RECORD_VALUES)
    const evidence = values.items?.properties?.evidence as Node
    expect(evidence.additionalProperties).toBe(false)
    expect((evidence.properties?.quote as { maxLength?: number }).maxLength).toBe(MAX_EVIDENCE_QUOTE_LENGTH)
  })

  it('names only the question types that write a value', () => {
    const type = defs().Need.properties?.type as { enum?: string[] }
    expect(type.enum).toEqual([...INTAKE_NEED_TYPES])
    expect(type.enum).not.toContain('upload')
    expect(type.enum).not.toContain('info_placeholder')
  })

  it('refuses a body that names more than its op allows', () => {
    expect(internalIntakeRequestSchema.safeParse({ op: 'needs', jobId: 'job-1' }).success).toBe(true)
    expect(internalIntakeRequestSchema.safeParse({ op: 'needs', jobId: 'job-1', projectId: 'p' }).success).toBe(false)
    expect(internalIntakeRequestSchema.safeParse({ op: 'needs' }).success).toBe(false)
    expect(
      internalIntakeRequestSchema.safeParse({
        op: 'record',
        jobId: 'job-1',
        values: [
          { key: 'geschosse_oberirdisch@bw1', value: 4, evidence: { fileName: 'EP_Schnitt.pdf', page: 2, quote: '4 Geschoße' } },
        ],
      }).success
    ).toBe(true)
  })
})
