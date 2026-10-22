/**
 * @vitest-environment node
 */
import { describe, expect, it } from 'vitest'
import { AGENT_OPERATIONS } from './catalog'
import { describeOperation, inputSchemaOf } from './discovery'
import { LAYER_THRESHOLD_CHARS, layerSchema, resolveField } from './layered-schema'
import type { AgentPrincipal } from './principal'

type Node = Record<string, unknown>

const big = (n: number): Node => ({
  type: 'object',
  properties: Object.fromEntries(Array.from({ length: n }, (_, i) => [`f${i}`, { type: 'string', description: 'x'.repeat(40) }])),
})
const body: Node = {
  type: 'object',
  description: 'The body.',
  properties: { files: { type: 'array', description: 'Files.', items: big(40) }, note: { type: 'string' }, deep: big(30) },
}
const params: Node = { type: 'object', properties: { projectId: { type: 'string', description: 'The project.' } }, required: ['projectId'] }
const schema: Node = { type: 'object', properties: { params, body } }

describe('layerSchema', () => {
  it('returns a small schema whole', () => {
    const small = big(3)
    expect(layerSchema(small)).toEqual({ schema: small, layered: false })
  })

  it('outlines the large fields, keeps the small ones, and names the field to open each', () => {
    expect(JSON.stringify(schema).length).toBeGreaterThan(LAYER_THRESHOLD_CHARS)
    const { schema: out, layered } = layerSchema(schema)
    const props = out.properties as Record<string, Node>
    expect(layered).toBe(true)
    expect(props.params).toEqual(params)
    expect(props.body).toMatchObject({ type: 'object', description: 'The body.', fields: ['files', 'note', 'deep'] })
    expect(props.body?.describe).toMatch(/field: "body"/)
    expect(JSON.stringify(out).length).toBeLessThan(LAYER_THRESHOLD_CHARS / 4)
  })

  it('resolves a dot path, stepping through array items, and says what exists when it misses', () => {
    expect(resolveField(schema, 'body.files')).toEqual({ node: (body.properties as Node).files })
    expect(resolveField(schema, 'body.files.f3')).toEqual({ node: { type: 'string', description: 'x'.repeat(40) } })
    expect(resolveField(schema, 'body.nope')).toEqual({
      error: 'no field "nope" under "body" in this input. Fields there: files, note, deep.',
    })
  })

  it('layers a subtree that is itself large, with the path of the whole', () => {
    const sub = resolveField({ type: 'object', properties: { body: { type: 'object', properties: { a: big(60) } } } }, 'body')
    const { schema: out, layered } = layerSchema((sub as { node: Node }).node, 'body')
    expect(layered).toBe(true)
    expect(JSON.stringify(out)).toContain('field: \\"body.a\\"')
  })
})

describe('describe-operation over the real catalog', () => {
  const session = {
    userId: 'u',
    email: 'a@piloti.test',
    name: null,
    accessToken: '',
    organizationId: 'o',
    organizationMembershipId: 'om',
    role: 'admin' as const,
    permissions: [],
    featureFlags: null,
  }
  const principal: AgentPrincipal = { actor: 'external_agent', session, clientId: 'c', scopes: ['piloti:sensitive'] }
  const run = (args: Record<string, unknown>) =>
    describeOperation({ principal, mode: 'search' }, args) as { isError?: boolean; structuredContent: Record<string, unknown> }

  it('layers exactly the operations past the threshold and returns every other whole', () => {
    const large = AGENT_OPERATIONS.filter((op) => JSON.stringify(inputSchemaOf(op)).length > LAYER_THRESHOLD_CHARS).map((op) => op.name)
    expect(large).toContain('project-profile-replace')
    for (const op of AGENT_OPERATIONS) {
      const result = run({ name: op.name })
      if (result.isError) continue
      expect(result.structuredContent.layered === true, op.name).toBe(large.includes(op.name))
    }
  })

  it('opens a layered field of the largest input', () => {
    const outline = run({ name: 'project-profile-replace' })
    expect(outline.structuredContent.layered).toBe(true)
    const shown = (outline.structuredContent.inputSchema as { properties: Record<string, { fields?: string[] }> }).properties
    const outlined = Object.entries(shown).find(([, node]) => node.fields)
    expect(outlined).toBeDefined()
    const [name, node] = outlined as [string, { fields: string[] }]
    const opened = run({ name: 'project-profile-replace', field: name })
    expect(opened.isError).toBeFalsy()
    expect(opened.structuredContent.field).toBe(name)
    expect(JSON.stringify(opened.structuredContent.inputSchema)).toContain(node.fields[0] as string)
  })

  it('refuses a field that is not there, naming the ones that are', () => {
    const result = run({ name: 'project-list', field: 'body.nope' })
    expect(result.isError).toBe(true)
  })
})
