/**
 * @vitest-environment node
 */
/**
 * The committed OpenAPI document is what a reviewer reads to see the agent
 * surface change, and this keeps it from going stale.
 *
 * It REWRITES the fixture when `UPDATE_FIXTURES=1` and otherwise compares, as
 * `lib/documents/lifecycle-schema.spec.ts` does: a generated artifact that
 * regenerates itself silently on every run is not a gate.
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { AGENT_OPERATIONS } from './catalog'
import { isOnDoor } from './exposure'
import { buildOpenApiDocument, documentedOperations, openApiPath } from './openapi'
import { pathParams } from './operation'

const FIXTURE = join(process.cwd(), 'tests/fixtures/openapi.json')
const SERVER_URL = 'https://piloti.example'

interface Parameter {
  name: string
  in: string
  required: boolean
}
interface Operation {
  operationId: string
  parameters?: Parameter[]
}
type Paths = Record<string, Record<string, Operation>>

const document = buildOpenApiDocument(AGENT_OPERATIONS, { serverUrl: SERVER_URL })
const paths = document.paths as Paths
const operations = Object.values(paths).flatMap((item) => Object.values(item))

describe('agent API OpenAPI document', () => {
  it('matches the committed fixture', () => {
    const generated = `${JSON.stringify(document, null, 2)}\n`
    if (process.env.UPDATE_FIXTURES === '1') {
      writeFileSync(FIXTURE, generated, 'utf8')
    }
    expect(
      readFileSync(FIXTURE, 'utf8'),
      'The operation catalog changed. Re-run with UPDATE_FIXTURES=1 and commit the fixture in the same change.',
    ).toBe(generated)
  })

  it('is OpenAPI 3.1', () => {
    expect(document.openapi).toBe('3.1.0')
  })

  it('gives every operation a unique operationId', () => {
    const ids = operations.map((op) => op.operationId)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('declares every path parameter as a required path parameter', () => {
    for (const [path, item] of Object.entries(paths)) {
      const names = [...path.matchAll(/\{([^}]+)\}/g)].map((match) => match[1])
      for (const op of Object.values(item)) {
        const declared = (op.parameters ?? []).filter((p) => p.in === 'path')
        expect(declared.map((p) => p.name), `${op.operationId} ${path}`).toEqual(names)
        expect(declared.every((p) => p.required), op.operationId).toBe(true)
      }
    }
  })

  it('carries every catalog operation at its path and method', () => {
    for (const op of AGENT_OPERATIONS) {
      const described = paths[openApiPath(op.path)]?.[op.method.toLowerCase()]
      expect(described?.operationId, `${op.method} ${op.path}`).toBe(op.name)
      expect(pathParams(op.path).length).toBe(
        (described?.parameters ?? []).filter((p) => p.in === 'path').length,
      )
    }
    expect(operations).toHaveLength(AGENT_OPERATIONS.length)
  })

  it('describes an upload as multipart/form-data with a binary file part and the route’s fields', () => {
    const upload = paths['/api/documents/upload']?.post as unknown as {
      requestBody: { content: Record<string, { schema: { properties: Record<string, unknown>; required: string[] } }> }
    }
    expect(Object.keys(upload.requestBody.content)).toEqual(['multipart/form-data'])
    const schema = upload.requestBody.content['multipart/form-data']?.schema
    expect(schema?.properties.file).toEqual({ type: 'string', format: 'binary' })
    expect(Object.keys(schema?.properties ?? {})).toEqual(expect.arrayContaining(['projectId', 'folderId', 'uploadBatchId']))
    expect(schema?.required).toEqual(['file', 'projectId'])
  })

  it('describes the mail import part as raw application/octet-stream', () => {
    const part = paths['/api/projects/{id}/mail-imports/{importId}/parts/{partNumber}']?.put as unknown as {
      requestBody: { content: Record<string, unknown> }
    }
    expect(part.requestBody.content).toEqual({ 'application/octet-stream': { schema: { type: 'string', format: 'binary' } } })
  })

  it('describes a file answer by its media types', () => {
    const exported = paths['/api/documents/{id}/file']?.get as unknown as {
      responses: { '200': { content: Record<string, unknown> } }
    }
    expect(Object.keys(exported.responses['200'].content)).toEqual(['application/pdf', 'text/plain'])
  })

  it('leads with the workspace, and names the MCP door', () => {
    const info = document.info as { title: string; description: string }
    expect(info.title).toBe('Piloti workspace API')
    expect(info.description.startsWith('Piloti is the workspace for architects')).toBe(true)
    expect(info.description).toContain('/api/mcp')
  })

  it('names the security the paths accept: the app session cookie, with MCP as the agent door', () => {
    expect(document.security).toEqual([{ sessionCookie: [] }])
    const schemes = (document.components as { securitySchemes: Record<string, { type: string; in?: string; description: string }> })
      .securitySchemes
    expect(Object.keys(schemes)).toEqual(['sessionCookie'])
    expect(schemes.sessionCookie).toMatchObject({ type: 'apiKey', in: 'cookie' })
    expect(schemes.sessionCookie.description).toMatch(/\/api\/mcp/)
  })

  it('shows the operator console to platform staff only', () => {
    const domains = (platformStaff: boolean) => new Set(documentedOperations(AGENT_OPERATIONS, { platformStaff }).map((op) => op.domain))
    expect(domains(false).has('platform')).toBe(false)
    expect(domains(true).has('platform')).toBe(true)
  })

  it('never documents a withheld operation, for anyone', () => {
    for (const platformStaff of [false, true]) {
      expect(documentedOperations(AGENT_OPERATIONS, { platformStaff }).filter((op) => !isOnDoor(op.name) && !isOnDoor(op.name, 'platform'))).toEqual([])
    }
  })
})
