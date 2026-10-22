/**
 * @vitest-environment node
 */
import { describe, expect, it } from 'vitest'
import { AGENT_OPERATIONS } from './catalog'
import { OperationInputError, validateOperationInput } from './dispatch'

const op = (name: string) => {
  const found = AGENT_OPERATIONS.find((candidate) => candidate.name === name)
  if (!found) throw new Error(`no operation ${name}`)
  return found
}

describe('a path or query key the operation does not take', () => {
  it('is refused with the keys it does take, rather than answered as though it held', () => {
    expect(() => validateOperationInput(op('project-list'), { query: { limit: 2 } })).toThrow(OperationInputError)
    expect(() => validateOperationInput(op('project-list'), { query: { limit: 2 } })).toThrow(
      /project-list: query\.limit is not an input; it takes view, nameContains/,
    )
  })

  it('leaves the keys an operation does take alone', () => {
    expect(() => validateOperationInput(op('project-list'), { query: { nameContains: 'Josef' } })).not.toThrow()
  })

  it('refuses a path key the route has no slot for', () => {
    const withParams = AGENT_OPERATIONS.find((candidate) => candidate.params && 'shape' in candidate.params)
    if (!withParams) throw new Error('no operation with path params')
    const params = Object.fromEntries(Object.keys((withParams.params as unknown as { shape: object }).shape).map((key) => [key, 'x']))
    expect(() => validateOperationInput(withParams, { params: { ...params, stray: 'y' } })).toThrow(/params\.stray is not an input/)
  })
})
