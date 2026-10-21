/**
 * @vitest-environment node
 */
/**
 * What a call names (`targetsOf`), over the real catalog. The read gate and the
 * proposal both judge a call by this answer, so a key it misses is a place
 * neither of them checks.
 */
import { describe, expect, it, vi } from 'vitest'

vi.mock('server-only', () => ({}))
vi.mock('./operation-targets-repository', () => ({ findTargetPlace: vi.fn(), findProjectName: vi.fn() }))

import { findOperation } from './catalog'
import { targetsOf } from './operation-targets'

const op = (name: string) => {
  const found = findOperation(name)
  if (!found) throw new Error(`${name} left the catalog`)
  return found
}

describe('targetsOf', () => {
  it('names the base model of a comparison beside the model in the path', () => {
    const targets = targetsOf(op('bim-model-query'), {
      params: { modelId: 'model-a' },
      body: { kind: 'compare', baseModelId: 'model-b' },
    })
    expect(targets).toEqual([
      { type: 'bim_model', id: 'model-a' },
      { type: 'bim_model', id: 'model-b' },
    ])
  })

  it('names the project a scoped list is narrowed to', () => {
    expect(targetsOf(op('conversation-list'), { query: { projectId: 'p1' } })).toEqual([{ type: 'project', id: 'p1' }])
  })
})
