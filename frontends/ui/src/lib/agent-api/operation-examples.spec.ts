/**
 * @vitest-environment node
 */
/**
 * An operation's `examples` are inputs an agent copies, so each must be one the
 * operation takes: it parses against the operation's own schemas and fills
 * every path parameter. An example that drifted from its schema would teach the
 * mistake it exists to prevent.
 */

import { describe, expect, it } from 'vitest'
import { AGENT_OPERATIONS } from './catalog'
import { inputSchemaOf } from './discovery'
import { resolvePath, validateOperationInput } from './dispatch'

const withExamples = AGENT_OPERATIONS.filter((op) => op.examples && op.examples.length > 0)

describe('operation examples', () => {
  it('exist for the inputs that are hardest to get right from the schema alone', () => {
    expect(withExamples.map((op) => op.name)).toEqual(
      expect.arrayContaining(['project-profile-patch', 'annotation-create', 'document-upload']),
    )
  })

  it.each(withExamples.map((op) => [op.name, op] as const))('%s: every example is an input it takes', (_name, op) => {
    expect(op.examples!.length).toBeLessThanOrEqual(3)
    for (const example of op.examples!) {
      expect(() => validateOperationInput(op, example)).not.toThrow()
      expect(() => resolvePath(op, example.params)).not.toThrow()
    }
    // And they reach the agent as JSON Schema's own `examples`.
    expect(inputSchemaOf(op).examples).toEqual(op.examples)
  })
})
