/**
 * @vitest-environment node
 */
import { describe, expect, it } from 'vitest'
import { AGENT_GROUP_IDS } from '@/lib/model-config/agent-groups'
import { modelConfigPutSchema } from '@/lib/organizations/organization-wire'
import { modelDefaultsPutSchema, reasoningEffortsPutSchema } from './platform-wire'

/**
 * A group left out of these bodies is cleared back to its default, so each map
 * takes any subset of the groups. Zod 4's `z.record` over an enum demands every
 * key; these hold the bodies to `z.partialRecord`.
 */
describe('a settings body may name only some agent groups', () => {
  const [group, other] = AGENT_GROUP_IDS

  it('takes an effort set for one group', () => {
    expect(reasoningEffortsPutSchema.safeParse({ efforts: { [group]: 'low' } }).success).toBe(true)
  })

  it('takes platform model defaults for one group', () => {
    expect(modelDefaultsPutSchema.safeParse({ defaults: { [group]: { model: 'author/model' } } }).success).toBe(true)
  })

  it('takes an organization override for one group', () => {
    expect(modelConfigPutSchema.safeParse({ overrides: { [other]: { model: 'author/model' } } }).success).toBe(true)
  })

  it('still refuses a group that does not exist', () => {
    expect(reasoningEffortsPutSchema.safeParse({ efforts: { 'no-such-group': 'low' } }).success).toBe(false)
  })
})
